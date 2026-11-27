import { randomUUID } from 'node:crypto';
import type { SyncCounts, SyncPlan, SyncRunStatus } from '@sm/shared';
import { prepare } from '../db/index.ts';
import { ApiError, notFound } from '../errors.ts';
import { getProjectRow } from '../services/projects.ts';
import { getSyncRunDto, getSyncRunRow, isTerminalStatus, updateSyncRun } from '../services/sync.ts';
import { getTargetRow, type TargetRow } from '../services/targets.ts';
import {
  activeByTarget,
  createFinisher,
  logLine,
  publish,
  registerActiveRun,
  setStatus,
  unregisterActiveRun,
  type StartSyncInput,
} from '../sync/run-utils.ts';
import { isDemoId } from './ids.ts';

const activeDemo = new Map<
  string,
  { targetId: string; cancel: () => void; controller: AbortController }
>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function isDemoSyncTarget(targetId: string): boolean {
  const target = getTargetRow(targetId);
  return Boolean(target && isDemoId(target.server_id));
}

export function isDemoSyncRun(runId: string): boolean {
  const row = getSyncRunRow(runId);
  if (!row?.target_id) return false;
  const target = getTargetRow(row.target_id);
  return Boolean(target && isDemoId(target.server_id));
}

function demoCounts(seed: number): SyncCounts {
  return {
    add: 3 + (seed % 4),
    updateSize: 1 + (seed % 3),
    updateMtime: seed % 2,
    same: 182,
    delete: 0,
    ignored: 61,
    protectedSkipped: 0,
    skippedSymlinks: 0,
  };
}

function buildPlan(
  runId: string,
  target: TargetRow,
  projectName: string,
  localRoot: string,
  counts: SyncCounts,
): SyncPlan {
  return {
    runId,
    mode: 'sftp',
    direction: 'local_to_remote',
    source: { label: `${projectName} · 本地`, serverId: null, dir: localRoot },
    dest: { label: target.label || target.server_name || target.id, serverId: target.server_id, dir: target.remote_code_dir },
    counts,
    bytes: {
      upload: counts.add * 640_000 + counts.updateSize * 210_000,
      delete: 0,
      totalLocal: 12_685_312,
    },
    actions: [
      { rel: 'src/model/evoformer.py', op: 'update', reason: 'size', size: 24_580, mtimeMs: Date.now() - 60_000 },
      { rel: 'configs/base.yaml', op: 'update', reason: 'mtime', size: 1_204, mtimeMs: Date.now() - 30_000 },
      { rel: 'src/data/loader.py', op: 'add', reason: 'missing', size: 8_420, mtimeMs: Date.now() - 300_000 },
      { rel: 'scripts/run_ablation.sh', op: 'add', reason: 'missing', size: 1_830, mtimeMs: Date.now() - 400_000 },
      { rel: 'train.py', op: 'update', reason: 'size', size: 12_300, mtimeMs: Date.now() - 90_000 },
    ],
    truncated: false,
    warnings: [],
    ignoreSample: [
      { rel: 'checkpoints/best.pt', rule: 'checkpoints/', source: 'project' },
      { rel: '.venv/lib/python3.10/site-packages/torch/__init__.py', rule: '.venv/', source: 'default' },
      { rel: '__pycache__/train.cpython-310.pyc', rule: '__pycache__/', source: 'default' },
    ],
  };
}

function mirrorConfirmed(target: TargetRow, confirmTargetName?: string): void {
  let config: { mirrorDelete?: boolean } = {};
  try {
    config = JSON.parse(target.sync_config_json) as { mirrorDelete?: boolean };
  } catch {
    config = {};
  }
  if (!config.mirrorDelete) return;
  const expected = target.label || target.server_name || target.id;
  if (confirmTargetName !== expected) {
    throw new ApiError(
      400,
      'MIRROR_DELETE_CONFIRM_REQUIRED',
      `镜像删除已开启，请输入目标名「${expected}」以确认本次操作（演示模式下同样执行此安全检查）`,
    );
  }
}

export function startDemoSync(input: StartSyncInput): ReturnType<typeof getSyncRunDto> {
  const target = getTargetRow(input.targetId);
  if (!target) throw notFound('目标');
  const project = getProjectRow(target.project_id);
  if (!project) throw notFound('项目');
  if (activeByTarget.has(target.id)) {
    throw new ApiError(409, 'SYNC_IN_PROGRESS', '该目标已有同步任务在运行，请等待完成或取消');
  }
  const dryRun = Boolean(input.dryRun);
  if (!dryRun) mirrorConfirmed(target, input.confirmTargetName);

  const runId = randomUUID();
  const seed = Date.now() / 1000;
  const counts = demoCounts(Math.floor(seed));
  const plan = buildPlan(runId, target, project.name, project.local_root, counts);
  const source = plan.source;
  const dest = plan.dest;

  prepare(
    `INSERT INTO sync_runs
       (id, project_id, target_id, mode, direction, source_json, dest_json, dry_run, status, started_at)
     VALUES (?, ?, ?, 'sftp', 'local_to_remote', ?, ?, ?, 'pending', ?)`,
  ).run(
    runId,
    project.id,
    target.id,
    JSON.stringify(source),
    JSON.stringify(dest),
    dryRun ? 1 : 0,
    Date.now(),
  );

  const controller = new AbortController();
  registerActiveRun(runId, target.id, controller);
  const finish = createFinisher(runId);
  const lines: string[] = [];
  const append = (level: 'info' | 'warn' | 'error', message: string): void => {
    lines.push(message);
    updateSyncRun(runId, { outputTail: lines.join('\n') });
    logLine(runId, level, message);
  };

  const entry = {
    targetId: target.id,
    controller,
    cancel: (): void => {
      controller.abort();
      append('warn', '收到取消请求，演示同步已停止');
      finish('canceled', { error: '已取消' });
      activeDemo.delete(runId);
    },
  };
  activeDemo.set(runId, entry);

  void (async () => {
    try {
      setStatus(runId, 'scanning');
      append('info', `演示模式：扫描本地目录 ${project.local_root}`);
      append('info', '忽略规则命中：checkpoints/、runs/、.venv/、__pycache__/');
      await sleep(700);
      if (controller.signal.aborted) return;

      updateSyncRun(runId, { planJson: JSON.stringify(plan) });
      publish(runId, { type: 'plan', runId, plan });
      append(
        'info',
        `差异：新增 ${counts.add}，按大小更新 ${counts.updateSize}，按时间更新 ${counts.updateMtime}，未变 ${counts.same}`,
      );

      if (dryRun) {
        append('info', '仅检查模式：未对目标机执行任何写操作');
        finish('done', { stats: { counts, bytes: plan.bytes } });
        activeDemo.delete(runId);
        return;
      }

      setStatus(runId, 'transferring');
      const filesTotal = counts.add + counts.updateSize + counts.updateMtime;
      const bytesTotal = plan.bytes.upload;
      const startedAt = Date.now();
      for (let i = 1; i <= 8; i += 1) {
        if (controller.signal.aborted) return;
        await sleep(280);
        const ratio = i / 8;
        const bytesDone = Math.round(bytesTotal * ratio);
        const elapsed = Math.max(1, Date.now() - startedAt);
        publish(runId, {
          type: 'progress',
          runId,
          phase: 'transferring',
          filesDone: Math.min(filesTotal, Math.round(filesTotal * ratio)),
          filesTotal,
          bytesDone,
          bytesTotal,
          rateBps: Math.round((bytesDone / elapsed) * 1000),
          etaMs: Math.round(((bytesTotal - bytesDone) / Math.max(1, bytesDone / elapsed)) * 1000),
        });
        if (i === 4) append('info', '分块传输中：写入临时文件后原子 rename，并保留 mtime');
      }
      append('info', `上传完成：${filesTotal} 个文件（演示数据）`);
      finish('done', { stats: { counts, bytes: plan.bytes } });
      activeDemo.delete(runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      append('error', `演示同步异常：${message}`);
      finish('failed', { error: message });
      activeDemo.delete(runId);
    }
  })();

  return getSyncRunDto(runId);
}

export function cancelDemoSync(runId: string): ReturnType<typeof getSyncRunDto> {
  const row = getSyncRunRow(runId);
  if (!row) throw notFound('同步记录');
  if (isTerminalStatus(row.status as SyncRunStatus)) {
    throw new ApiError(409, 'SYNC_NOT_RUNNING', '该同步已结束，无法取消');
  }
  const entry = activeDemo.get(runId);
  if (entry) {
    entry.cancel();
  } else {
    updateSyncRun(runId, { status: 'canceled', error: '已取消', finishedAt: Date.now() });
    publish(runId, { type: 'done', runId, status: 'canceled', counts: null, error: '已取消' });
    unregisterActiveRun(runId);
  }
  return getSyncRunDto(runId);
}