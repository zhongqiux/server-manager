import type { Response } from 'express';
import type { JobStatus } from '@sm/shared';
import { isJobTerminal, JOB_LAUNCHER_LABELS } from '@sm/shared';
import { prepare } from '../db/index.ts';
import type { JobRow } from '../services/jobs.ts';
import { getJobRow } from '../services/jobs.ts';
import { initSse, sendSse, startHeartbeat } from '../realtime/sse.ts';

const SNAPSHOT_BYTES = 32 * 1024;
const MAX_RUNNING_LINES = 5000;
const PROTEIN_LINES_PER_EPOCH = 42;
const DIFFUSION_STEPS_PER_LINE = 12;

type JobKind = 'protein' | 'diffusion' | 'generic';

function jobKind(title: string, command: string): JobKind {
  const text = `${title} ${command}`;
  if (/AF2|蛋白|protein|evoformer/i.test(text)) return 'protein';
  if (/LoRA|微调|diffusion|train_lora|accelerate/i.test(text)) return 'diffusion';
  return 'generic';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function launcherLabel(value: string | null): string {
  return value === 'tmux' || value === 'screen' || value === 'nohup'
    ? JOB_LAUNCHER_LABELS[value]
    : '启动中';
}

function headerLines(job: JobRow): string[] {
  const started = job.started_at ?? job.created_at;
  const session = job.session_name ?? launcherLabel(job.launcher);
  return [
    '===== Server Manager 演示日志 =====',
    `任务: ${job.title}`,
    `服务器: ${job.server_name ?? '演示服务器'}    会话: ${session}`,
    `开始: ${new Date(started).toLocaleString('zh-CN')}    日志: ${job.log_path ?? '(演示内存日志)'}`,
    '说明: 演示模式生成的合成日志，运行中每 5 秒追加一行，不会连接真实服务器',
    '==================================',
    '',
  ];
}

function proteinLines(job: JobRow, count: number, compact = false): string[] {
  const started = job.started_at ?? job.created_at;
  const lines = [
    `[${clock(started + 100)}] INFO config      : configs/base.yaml`,
    `[${clock(started + 300)}] INFO dataset     : /mnt/nvme/af2-data (48,210 samples, mmap)`,
    `[${clock(started + 500)}] INFO model       : evoformer-base params=93.1M trainable=100%`,
    `[${clock(started + 700)}] INFO optimizer   : AdamW lr=1.2e-4 betas=(0.9,0.98) clip=1.0`,
    `[${clock(started + 900)}] INFO dataloader  : batch_size=8 workers=8 pin_memory=true`,
    `[${clock(started + 1100)}] INFO start training: epochs=50`,
  ];
  if (compact) {
    const epochs = Math.min(count, 50);
    for (let i = 1; i <= epochs; i += 1) {
      const loss = Math.max(0.0001, 1.8421 * Math.exp(-i / 28) + 0.021 * Math.sin(i * 1.7)).toFixed(4);
      const val = Math.max(0.0001, 1.632 * Math.exp(-i / 31) + 0.018 * Math.cos(i * 1.3)).toFixed(4);
      const lr = Math.max(1e-6, 1.2e-4 * (1 - i / 60)).toExponential(2);
      const gpu1 = i % 9 === 0 ? 4 : 2;
      lines.push(
        `[${clock(started + 7000 + i * 12_000)}] INFO epoch ${i}/50 loss=${loss} val_loss=${val} lr=${lr} gpu0=87% gpu1=${gpu1}% 12.4s`,
      );
    }
    for (let i = epochs + 1; i <= count; i += 1) {
      const fold = ((i - epochs - 1) % 8) + 1;
      lines.push(
        `[${clock(started + 7000 + i * 12_000)}] INFO eval fold ${fold}/8 loss=0.4107 gpu0=84% 2.1s`,
      );
    }
    return lines;
  }
  for (let i = 1; i <= count; i += 1) {
    const epoch = Math.min(50, Math.floor((i - 1) / PROTEIN_LINES_PER_EPOCH) + 1);
    const batch = ((i - 1) % PROTEIN_LINES_PER_EPOCH) + 1;
    const loss = Math.max(
      0.0001,
      1.8421 * Math.exp(-epoch / 28) + 0.02 * Math.sin(i * 0.37) + 0.0004 * (batch % 7),
    ).toFixed(4);
    const lr = Math.max(1e-6, 1.2e-4 * (1 - epoch / 60)).toExponential(2);
    const gpu1 = i % 9 === 0 ? 4 : 2;
    const at = clock(started + 1200 + i * 5000);
    if (epoch < 50) {
      lines.push(
        `[${at}] INFO epoch ${epoch}/50 batch ${batch}/${PROTEIN_LINES_PER_EPOCH} loss=${loss} lr=${lr} gpu0=87% gpu1=${gpu1}% 4.8s/batch`,
      );
    } else {
      const fold = ((i - 50 * PROTEIN_LINES_PER_EPOCH) % 8) + 1;
      lines.push(`[${at}] INFO post-train eval fold ${fold}/8 loss=0.4107 gpu0=84% 2.1s`);
    }
  }
  return lines;
}

function diffusionLines(job: JobRow, count: number, compact = false): string[] {
  const started = job.started_at ?? job.created_at;
  const lines = [
    `[${clock(started + 1000)}] INFO accelerate   : distributed_type=NO num_processes=1 mixed_precision=fp16`,
    `[${clock(started + 2400)}] INFO dataset      : /data/laion-subset (12,408 images, resolution=512)`,
    `[${clock(started + 3800)}] INFO model        : runwayml/stable-diffusion-v1-5 + LoRA r=16 alpha=16`,
    `[${clock(started + 5200)}] INFO optimizer    : AdamW8bit lr=1.0e-4 steady_state=200`,
    `[${clock(started + 6600)}] INFO train        : steps=20000 batch_size=4 grad_accum=2`,
  ];
  const stepsPerLine = compact ? 100 : DIFFUSION_STEPS_PER_LINE;
  for (let i = 1; i <= count; i += 1) {
    const step = Math.min(20000, i * stepsPerLine);
    const sec = (0.41 + 0.02 * Math.sin(i * 0.7)).toFixed(2);
    const at = clock(started + 1200 + i * (compact ? 6000 : 5000));
    if (step < 20000) {
      const loss = Math.max(0.003, 0.062 * Math.exp(-step / 6000) + 0.006 * Math.sin(i * 0.9)).toFixed(4);
      const lr = Math.max(1e-6, 1e-4 * Math.exp(-step / 15000)).toExponential(2);
      lines.push(`[${at}] INFO step ${step}/20000 loss=${loss} lr=${lr} gpu=96% ${sec}s/step`);
    } else {
      const sample = ((i - 20000 / stepsPerLine) % 4) + 1;
      lines.push(`[${at}] INFO final eval sample ${sample}/4 steps=20000 gpu=93%`);
    }
  }
  return lines;
}

function genericLines(job: JobRow, count: number): string[] {
  const started = job.started_at ?? job.created_at;
  const lines = [
    `[${clock(started)}] INFO working dir: ${job.script_path ?? '~/.server_manager'}`,
    `[${clock(started + 1000)}] INFO command   : ${job.rendered_command}`,
  ];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`[${clock(started + 1000 + i * 5000)}] INFO heartbeat ${i} elapsed=${i * 5}s status=ok`);
  }
  return lines;
}

function trainingLines(job: JobRow, kind: JobKind, count: number, compact = false): string[] {
  if (kind === 'protein') return proteinLines(job, count, compact);
  if (kind === 'diffusion') return diffusionLines(job, count, compact);
  return genericLines(job, count);
}

function terminalSuffix(job: JobRow, kind: JobKind): string[] {
  const finished = job.finished_at ?? Date.now();
  const status = job.status as JobStatus;
  if (status === 'canceled') {
    return [
      '',
      '^C received, saving checkpoint and shutting down...',
      `[${clock(finished - 2000)}] INFO checkpoint saved to runs/last.pt`,
      `[${clock(finished - 1000)}] INFO process group terminated (SIGTERM)`,
      '[Server Manager] exit code 130 (canceled)',
    ];
  }
  if (status === 'failed') {
    return [
      '',
      'Traceback (most recent call last):',
      '  File "train_lora.py", line 188, in <module>',
      '    loss = model(batch).loss',
      '  File "site-packages/diffusers/models/unet_2d_condition.py", line 541, in forward',
      '    sample = self.conv_in(sample)',
      'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB',
      '  (GPU 0; 23.62 GiB total capacity; 22.91 GiB already allocated)',
      '',
      '[Server Manager] exit code 1 (failed)',
    ];
  }
  if (status === 'lost') {
    return ['', '[Server Manager] 远程会话已消失，且未写入退出码', '[Server Manager] status = lost'];
  }
  if (status === 'exited') {
    const extra =
      kind === 'diffusion'
        ? [
            'INFO saving LoRA weights to outputs/lora-epoch-2.safetensors',
            'INFO training finished: best_loss=0.0312, steps=20000',
          ]
        : kind === 'protein'
          ? [
              'INFO saving best checkpoint to /mnt/nvme/af2-data/runs/exp-042/best.pt',
              'INFO training finished: best_val_loss=0.4107, epochs=50',
            ]
          : ['INFO run finished'];
    return [
      '',
      ...extra.map((line, index) => `[${clock(finished - 5000 + index * 1000)}] ${line}`),
      '[Server Manager] exit code 0 (exited)',
    ];
  }
  return ['', '[Server Manager] 任务尚未结束'];
}

function lineCount(started: number, end: number): number {
  return Math.max(0, Math.min(Math.floor((end - started) / 5000), MAX_RUNNING_LINES));
}

export function demoLogText(job: JobRow): string {
  const kind = jobKind(job.title, job.rendered_command);
  const status = job.status as JobStatus;
  const started = job.started_at ?? job.created_at;
  const header = headerLines(job);

  if (isJobTerminal(status)) {
    const ended = job.finished_at ?? Date.now();
    const live = Date.now() - ended < 60_000;
    const compactTotal =
      kind === 'diffusion' ? 205 : kind === 'protein' ? 55 : status === 'canceled' ? 6 : 12;
    const count = live ? lineCount(started, ended) : compactTotal;
    const lines = [...header, ...trainingLines(job, kind, count, !live), ...terminalSuffix(job, kind)];
    return `${lines.join('\n')}\n`;
  }

  const count = lineCount(started, Date.now());
  const lines = [...header, ...trainingLines(job, kind, count)];
  return `${lines.join('\n')}\n`;
}

export function demoReadChunk(
  job: JobRow,
  endInput?: number,
  bytes = 131072,
): { start: number; end: number; size: number; data: string } {
  const buf = Buffer.from(demoLogText(job), 'utf8');
  const size = buf.length;
  const end = Math.min(endInput ?? size, size);
  const start = Math.max(0, end - bytes);
  const slice = buf.subarray(start, end);
  return { start, end: start + slice.length, size, data: slice.toString('base64') };
}

export function demoLogDownloadText(job: JobRow): string {
  return demoLogText(job);
}

const watchers = new Map<string, Set<() => void>>();

export function refreshDemoJobTelemetry(serverId: string): void {
  const rows = prepare(
    "SELECT id FROM jobs WHERE server_id = ? AND status IN ('pending', 'starting', 'running')",
  ).all(serverId) as { id: string }[];
  const now = Date.now();
  for (const { id } of rows) {
    const job = getJobRow(id);
    if (!job) continue;
    const bytes = Buffer.byteLength(demoLogText(job), 'utf8');
    prepare('UPDATE jobs SET last_seen_at = ?, log_bytes = ? WHERE id = ?').run(now, bytes, id);
  }
}

export function demoNotifyJobTerminal(jobId: string): void {
  for (const notify of [...(watchers.get(jobId) ?? [])]) notify();
}

export function streamDemoJobLog(job: JobRow, res: Response, lastOffset: number): void {
  initSse(res);
  const stopHeartbeat = startHeartbeat(res);
  const jobId = job.id;
  let closed = false;
  let offset = 0;
  let currentBuf: Buffer | null = null;
  let timer: NodeJS.Timeout | null = null;

  const pushLatest = (fresh: JobRow): void => {
    const nextBuf = Buffer.from(demoLogText(fresh), 'utf8');
    const rewritten =
      currentBuf !== null &&
      offset > 0 &&
      !nextBuf.subarray(0, offset).equals(currentBuf.subarray(0, offset));
    if (rewritten) {
      const start = Math.max(0, nextBuf.length - SNAPSHOT_BYTES);
      sendSse(
        res,
        {
          type: 'reset',
          jobId,
          start,
          offset: nextBuf.length,
          size: nextBuf.length,
          data: nextBuf.subarray(start).toString('base64'),
          reason: 'demo_log_rewritten',
        },
        nextBuf.length,
      );
    } else if (nextBuf.length > offset) {
      sendSse(
        res,
        { type: 'log', jobId, offset: nextBuf.length, data: nextBuf.subarray(offset).toString('base64') },
        nextBuf.length,
      );
    } else {
      return;
    }
    currentBuf = nextBuf;
    offset = nextBuf.length;
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    if (timer) clearInterval(timer);
    timer = null;
    watchers.get(jobId)?.delete(onTerminal);
  };

  const finishStream = (): void => {
    if (closed) return;
    const fresh = getJobRow(jobId);
    if (fresh) pushLatest(fresh);
    sendSse(res, { type: 'end', jobId, reason: 'job_terminal' });
    cleanup();
    try {
      res.end();
    } catch {
      // 忽略
    }
  };

  const onTerminal = (): void => finishStream();

  const initial = getJobRow(jobId) ?? job;
  const buf = Buffer.from(demoLogText(initial), 'utf8');
  const size = buf.length;
  const start =
    lastOffset > 0 && lastOffset <= size ? lastOffset : Math.max(0, size - SNAPSHOT_BYTES);
  const slice = buf.subarray(start);
  sendSse(
    res,
    { type: 'snapshot', jobId, start, offset: size, size, data: slice.toString('base64') },
    size,
  );
  offset = size;
  currentBuf = buf;

  if (isJobTerminal(initial.status as JobStatus)) {
    sendSse(res, { type: 'end', jobId, reason: 'job_terminal' });
    cleanup();
    res.end();
    return;
  }

  const set = watchers.get(jobId) ?? new Set<() => void>();
  set.add(onTerminal);
  watchers.set(jobId, set);
  res.on('close', cleanup);

  timer = setInterval(() => {
    if (closed) return;
    const fresh = getJobRow(jobId);
    if (!fresh) {
      finishStream();
      return;
    }
    if (isJobTerminal(fresh.status as JobStatus)) {
      finishStream();
      return;
    }
    pushLatest(fresh);
  }, 1000);
  timer.unref();
}