import type { SyncCounts, SyncPlan } from '@sm/shared';
import { prepare } from '../db/index.ts';
import { encryptSecret, secretAad } from '../crypto/secrets.ts';
import { createLogger } from '../logger.ts';
import { DEMO_CAPS, demoHardware } from './fixtures.ts';
import {
  DEMO_JOB,
  DEMO_PROJECT,
  DEMO_RUN,
  DEMO_RUNNING_JOB_IDS,
  DEMO_SERVER,
  DEMO_TARGET,
} from './ids.ts';

const log = createLogger('demo');

const SEED_KEY = 'demo.seed.v1';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

function localRoot(name: string): string {
  return process.platform === 'win32' ? `D:\\ai-lab\\${name}` : `/home/demo/ai-lab/${name}`;
}

function insertServer(options: {
  id: string;
  name: string;
  host: string;
  username: string;
  color: string;
  tags: string[];
  notes: string;
  sortOrder: number;
  now: number;
}): void {
  prepare(
    `INSERT OR IGNORE INTO servers
       (id, name, host, port, username, auth_type, password_enc, private_key_enc, passphrase_enc,
        host_key_policy, host_key_fp, color, tags_json, notes, sort_order, status, status_msg,
        last_ok_at, caps_json, hw_json, hw_at, created_at, updated_at)
     VALUES (?, ?, ?, 22, ?, 'password', ?, NULL, NULL, 'tofu', ?, ?, ?, ?, ?, 'online',
        '演示数据（合成）', ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.id,
    options.name,
    options.host,
    options.username,
    encryptSecret(`demo-unused:${options.id}`, secretAad(options.id, 'password')),
    `SHA256:demo${options.id.slice(-6)}fingerprint`,
    options.color,
    JSON.stringify(options.tags),
    options.notes,
    options.sortOrder,
    options.now,
    JSON.stringify(DEMO_CAPS),
    JSON.stringify(demoHardware(options.id)),
    options.now,
    options.now - 30 * day,
    options.now,
  );
}

function insertProject(options: {
  id: string;
  name: string;
  dirName: string;
  ignoreExtra: string[];
  now: number;
}): void {
  prepare(
    `INSERT OR IGNORE INTO projects
       (id, name, local_root, ignore_extra_json, exec_bit_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'auto', ?, ?)`,
  ).run(
    options.id,
    options.name,
    localRoot(options.dirName),
    JSON.stringify(options.ignoreExtra),
    options.now - 20 * day,
    options.now,
  );
}

type TargetSeed = {
  id: string;
  projectId: string;
  serverId: string;
  label: string;
  remoteCodeDir: string;
  dataDir: string;
  condaEnv: string;
  envVars: Record<string, string>;
  preCommand: string | null;
  runCommand: string;
  gpuDevices: string | null;
  extraIgnores: string[];
  keepSession: boolean;
};

function insertTarget(seed: TargetSeed, now: number): void {
  prepare(
    `INSERT OR IGNORE INTO targets
       (id, project_id, server_id, label, remote_code_dir, data_dir, conda_env, env_vars_json,
        pre_command, run_command, gpu_devices, sync_mode, sync_config_json, keep_session,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sftp', ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.projectId,
    seed.serverId,
    seed.label,
    seed.remoteCodeDir,
    seed.dataDir,
    seed.condaEnv,
    JSON.stringify(seed.envVars),
    seed.preCommand,
    seed.runCommand,
    seed.gpuDevices,
    JSON.stringify({ extraIgnores: seed.extraIgnores, mirrorDelete: false }),
    seed.keepSession ? 1 : 0,
    now - 18 * day,
    now,
  );
}

type JobSeed = {
  id: string;
  targetId: string;
  projectId: string;
  serverId: string;
  title: string;
  status: 'running' | 'exited' | 'failed' | 'canceled';
  launcher: 'tmux' | 'screen' | null;
  sessionName: string | null;
  remotePid: number | null;
  logPath: string | null;
  renderedCommand: string;
  exitCode: number | null;
  error: string | null;
  syncRunId: string | null;
  logBytes: number;
  createdAt: number;
  startedAt: number;
  finishedAt: number | null;
  home: string;
};

function insertJob(seed: JobSeed): void {
  prepare(
    `INSERT OR IGNORE INTO jobs
       (id, target_id, project_id, server_id, title, status, launcher, tmux_session, remote_pid,
        remote_pgid, script_path, log_path, exit_path, rendered_command, script_content,
        exit_code, error, sync_run_id, log_bytes, created_at, started_at, finished_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.targetId,
    seed.projectId,
    seed.serverId,
    seed.title,
    seed.status,
    seed.launcher,
    seed.sessionName,
    seed.remotePid,
    seed.remotePid,
    seed.logPath ? seed.logPath.replace('/logs/', '/jobs/').replace(/\.log$/, '.sh') : null,
    seed.logPath,
    seed.logPath ? seed.logPath.replace(/\.log$/, '.exit') : null,
    seed.renderedCommand,
    `#!/usr/bin/env bash\nset -uo pipefail\ncd ~\n${seed.renderedCommand}\n`,
    seed.exitCode,
    seed.error,
    seed.syncRunId,
    seed.logBytes,
    seed.createdAt,
    seed.startedAt,
    seed.finishedAt,
    seed.finishedAt ?? Date.now(),
  );
}

function insertEvent(jobId: string, ts: number, kind: string, message: string, data?: unknown): void {
  prepare(
    'INSERT INTO job_events (job_id, ts, kind, message, data_json) VALUES (?, ?, ?, ?, ?)',
  ).run(jobId, ts, kind, message, data === undefined ? null : JSON.stringify(data));
}

function seedRunningEvents(jobId: string, createdAt: number, startedAt: number, session: string): void {
  insertEvent(jobId, createdAt, 'created', '任务已创建，等待调度');
  insertEvent(jobId, createdAt + 1500, 'status', '开始同步代码…', { from: 'pending', to: 'syncing' });
  insertEvent(jobId, createdAt + 4000, 'status', '代码同步完成，准备启动脚本');
  insertEvent(jobId, startedAt - 1000, 'status', '任务已启动（tmux 会话）', {
    from: 'syncing',
    to: 'starting',
    session,
  });
  insertEvent(jobId, startedAt + 2000, 'status', '检测到任务已在远程运行', {
    from: 'starting',
    to: 'running',
  });
}

function seedSyncRun(options: {
  id: string;
  projectId: string;
  projectName: string;
  localDir: string;
  targetId: string;
  targetLabel: string;
  serverId: string;
  remoteDir: string;
  dryRun: boolean;
  startedAt: number;
  durationMs: number;
  counts: SyncCounts;
  bytes: { upload: number; delete: number; totalLocal: number };
}): void {
  const plan: SyncPlan = {
    runId: options.id,
    mode: 'sftp',
    direction: 'local_to_remote',
    source: { label: `${options.projectName} · 本地`, serverId: null, dir: options.localDir },
    dest: { label: options.targetLabel, serverId: options.serverId, dir: options.remoteDir },
    counts: options.counts,
    bytes: options.bytes,
    actions: [
      { rel: 'src/trainer.py', op: 'update', reason: 'size', size: 32_140, mtimeMs: options.startedAt - hour },
      { rel: 'configs/exp.yaml', op: 'add', reason: 'missing', size: 980, mtimeMs: options.startedAt - hour },
    ],
    truncated: false,
    warnings: [],
    ignoreSample: [
      { rel: 'checkpoints/last.pt', rule: 'checkpoints/', source: 'project' },
      { rel: '__pycache__/trainer.cpython-310.pyc', rule: '__pycache__/', source: 'default' },
    ],
  };
  const source = plan.source;
  const dest = plan.dest;
  prepare(
    `INSERT OR IGNORE INTO sync_runs
       (id, project_id, target_id, mode, direction, source_json, dest_json, dry_run, status,
        stats_json, plan_json, output_tail, error, started_at, finished_at)
     VALUES (?, ?, ?, 'sftp', 'local_to_remote', ?, ?, ?, 'done', ?, ?, ?, NULL, ?, ?)`,
  ).run(
    options.id,
    options.projectId,
    options.targetId,
    JSON.stringify(source),
    JSON.stringify(dest),
    options.dryRun ? 1 : 0,
    JSON.stringify({ counts: options.counts, bytes: options.bytes }),
    JSON.stringify(plan),
    [
      `扫描本地文件：184 个（忽略 61 个）`,
      `差异：新增 ${options.counts.add}，按大小更新 ${options.counts.updateSize}，按时间更新 ${options.counts.updateMtime}`,
      options.dryRun ? '仅检查模式：未对目标机执行任何写操作' : `上传完成：${options.counts.add + options.counts.updateSize + options.counts.updateMtime} 个文件`,
      `演示模式：以上为合成同步记录`,
    ].join('\n'),
    options.startedAt,
    options.startedAt + options.durationMs,
  );
}

function seedAll(now: number): void {
  insertServer({
    id: DEMO_SERVER.a100,
    name: 'A100 双卡实验机',
    host: '192.0.2.10',
    username: 'gpu',
    color: '#2563eb',
    tags: ['实验室', 'A100×2'],
    notes: '组内共享训练机，夜间优先保障学生实验；数据盘挂在 /mnt/nvme。',
    sortOrder: 0,
    now,
  });
  insertServer({
    id: DEMO_SERVER.rtx4090,
    name: '4090 工作站',
    host: '192.0.2.11',
    username: 'lab',
    color: '#db2777',
    tags: ['实验室', 'RTX 4090'],
    notes: '单卡 4090，适合 LoRA 微调与调试；显卡温度偏高时注意机箱风道。',
    sortOrder: 1,
    now,
  });
  insertServer({
    id: DEMO_SERVER.cloud,
    name: '云 GPU · 4×3090',
    host: '192.0.2.12',
    username: 'root',
    color: '#0891b2',
    tags: ['云', '3090×4'],
    notes: '按量计费的云主机，用完记得在控制台关机。',
    sortOrder: 2,
    now,
  });

  insertProject({
    id: DEMO_PROJECT.protein,
    name: '蛋白质结构预测',
    dirName: 'protein-fold',
    ignoreExtra: ['checkpoints/', 'runs/', '*.ckpt'],
    now,
  });
  insertProject({
    id: DEMO_PROJECT.diffusion,
    name: '扩散模型 LoRA 微调',
    dirName: 'diffusion-finetune',
    ignoreExtra: ['outputs/', '*.safetensors', 'wandb/'],
    now,
  });

  insertTarget(
    {
      id: DEMO_TARGET.proteinA100,
      projectId: DEMO_PROJECT.protein,
      serverId: DEMO_SERVER.a100,
      label: 'A100 · 主训练',
      remoteCodeDir: '/home/gpu/projects/protein-fold',
      dataDir: '/mnt/nvme/af2-data',
      condaEnv: 'torch210',
      envVars: { WANDB_MODE: 'offline', OMP_NUM_THREADS: '8' },
      preCommand: 'source ~/miniconda3/etc/profile.d/conda.sh',
      runCommand: 'python -u train.py --config configs/base.yaml --out {{data_dir}}/runs/exp-042',
      gpuDevices: '0,1',
      extraIgnores: ['checkpoints/', 'runs/'],
      keepSession: true,
    },
    now,
  );
  insertTarget(
    {
      id: DEMO_TARGET.proteinCloud,
      projectId: DEMO_PROJECT.protein,
      serverId: DEMO_SERVER.cloud,
      label: '3090×2 · 对照实验',
      remoteCodeDir: '/data/projects/protein-fold',
      dataDir: '/data/datasets/af2',
      condaEnv: 'pt21',
      envVars: { CUDA_VISIBLE_DEVICES: '0,1' },
      preCommand: null,
      runCommand: 'python -u train.py --config configs/small.yaml --batch-size 2',
      gpuDevices: '0,1',
      extraIgnores: ['checkpoints/'],
      keepSession: false,
    },
    now,
  );
  insertTarget(
    {
      id: DEMO_TARGET.diffusion4090,
      projectId: DEMO_PROJECT.diffusion,
      serverId: DEMO_SERVER.rtx4090,
      label: '4090 · LoRA',
      remoteCodeDir: '/home/lab/diffusion',
      dataDir: '/data/laion-subset',
      condaEnv: 'diffusers',
      envVars: { HF_HOME: '/data/hf-cache' },
      preCommand: 'source ~/miniconda3/etc/profile.d/conda.sh',
      runCommand: 'accelerate launch train_lora.py --steps 20000 --batch-size 4',
      gpuDevices: null,
      extraIgnores: ['outputs/', 'runs/'],
      keepSession: true,
    },
    now,
  );
  insertTarget(
    {
      id: DEMO_TARGET.diffusionCloud,
      projectId: DEMO_PROJECT.diffusion,
      serverId: DEMO_SERVER.cloud,
      label: '云集群 · 4×3090',
      remoteCodeDir: '/home/root/diffusion',
      dataDir: '/data/laion-subset',
      condaEnv: 'diffusers',
      envVars: {},
      preCommand: null,
      runCommand: 'python -u train_lora.py --steps 8000',
      gpuDevices: '0,1,2,3',
      extraIgnores: ['outputs/'],
      keepSession: false,
    },
    now,
  );

  const proteinStarted = now - 40 * minute;
  insertJob({
    id: DEMO_JOB.proteinRunning,
    targetId: DEMO_TARGET.proteinA100,
    projectId: DEMO_PROJECT.protein,
    serverId: DEMO_SERVER.a100,
    title: 'AF2 训练 · epoch 12/50',
    status: 'running',
    launcher: 'tmux',
    sessionName: 'sm_d0d03001',
    remotePid: 21_437,
    logPath: '/home/gpu/.server_manager/logs/d0d03001.log',
    renderedCommand: 'python -u train.py --config configs/base.yaml --out /mnt/nvme/af2-data/runs/exp-042',
    exitCode: null,
    error: null,
    syncRunId: DEMO_RUN.proteinA100,
    logBytes: 184_320,
    createdAt: now - 41 * minute,
    startedAt: proteinStarted,
    finishedAt: null,
    home: '/home/gpu',
  });
  seedRunningEvents(DEMO_JOB.proteinRunning, now - 41 * minute, proteinStarted, 'sm_d0d03001');

  const loraStarted = now - 57 * minute;
  insertJob({
    id: DEMO_JOB.diffusionRunning,
    targetId: DEMO_TARGET.diffusion4090,
    projectId: DEMO_PROJECT.diffusion,
    serverId: DEMO_SERVER.rtx4090,
    title: 'LoRA 微调 · step 8200',
    status: 'running',
    launcher: 'tmux',
    sessionName: 'sm_d0d03002',
    remotePid: 408_812,
    logPath: '/home/lab/.server_manager/logs/d0d03002.log',
    renderedCommand: 'accelerate launch train_lora.py --steps 20000 --batch-size 4',
    exitCode: null,
    error: null,
    syncRunId: null,
    logBytes: 512_000,
    createdAt: now - 58 * minute,
    startedAt: loraStarted,
    finishedAt: null,
    home: '/home/lab',
  });
  seedRunningEvents(DEMO_JOB.diffusionRunning, now - 58 * minute, loraStarted, 'sm_d0d03002');

  const baselineStarted = now - 6 * hour;
  insertJob({
    id: DEMO_JOB.baselineExited,
    targetId: DEMO_TARGET.proteinCloud,
    projectId: DEMO_PROJECT.protein,
    serverId: DEMO_SERVER.cloud,
    title: '3090 基线 · 消融 A',
    status: 'exited',
    launcher: 'tmux',
    sessionName: null,
    remotePid: 98_211,
    logPath: '/root/.server_manager/logs/d0d03003.log',
    renderedCommand: 'python -u train.py --config configs/small.yaml --batch-size 2',
    exitCode: 0,
    error: null,
    syncRunId: DEMO_RUN.proteinCloud,
    logBytes: 96_200,
    createdAt: baselineStarted - minute,
    startedAt: baselineStarted,
    finishedAt: now - 5 * hour,
    home: '/root',
  });
  insertEvent(DEMO_JOB.baselineExited, baselineStarted - minute, 'created', '任务已创建，等待调度');
  insertEvent(DEMO_JOB.baselineExited, baselineStarted, 'status', '任务已启动（tmux 会话）', {
    from: 'pending',
    to: 'running',
  });
  insertEvent(DEMO_JOB.baselineExited, now - 5 * hour, 'status', '任务结束，退出码 0', {
    from: 'running',
    to: 'exited',
    exitCode: 0,
  });

  const failedStarted = now - 26 * hour;
  insertJob({
    id: DEMO_JOB.loraFailed,
    targetId: DEMO_TARGET.diffusion4090,
    projectId: DEMO_PROJECT.diffusion,
    serverId: DEMO_SERVER.rtx4090,
    title: 'LoRA 试跑 · batch 16（OOM）',
    status: 'failed',
    launcher: 'tmux',
    sessionName: null,
    remotePid: 391_204,
    logPath: '/home/lab/.server_manager/logs/d0d03004.log',
    renderedCommand: 'accelerate launch train_lora.py --steps 500 --batch-size 16',
    exitCode: 1,
    error: '退出码 1',
    syncRunId: null,
    logBytes: 41_800,
    createdAt: failedStarted - minute,
    startedAt: failedStarted,
    finishedAt: failedStarted + 3 * minute,
    home: '/home/lab',
  });
  insertEvent(DEMO_JOB.loraFailed, failedStarted - minute, 'created', '任务已创建，等待调度');
  insertEvent(DEMO_JOB.loraFailed, failedStarted, 'status', '任务已启动（tmux 会话）', {
    from: 'pending',
    to: 'running',
  });
  insertEvent(DEMO_JOB.loraFailed, failedStarted + 3 * minute, 'status', '任务结束，退出码 1', {
    from: 'running',
    to: 'failed',
    exitCode: 1,
  });

  const canceledStarted = now - 2 * day - hour;
  insertJob({
    id: DEMO_JOB.proteinCanceled,
    targetId: DEMO_TARGET.proteinA100,
    projectId: DEMO_PROJECT.protein,
    serverId: DEMO_SERVER.a100,
    title: 'AF2 调试 · 小样本',
    status: 'canceled',
    launcher: 'tmux',
    sessionName: null,
    remotePid: 19_882,
    logPath: '/home/gpu/.server_manager/logs/d0d03005.log',
    renderedCommand: 'python -u train.py --debug --limit-batches 20',
    exitCode: null,
    error: null,
    syncRunId: null,
    logBytes: 12_600,
    createdAt: canceledStarted - minute,
    startedAt: canceledStarted,
    finishedAt: canceledStarted + 8 * minute,
    home: '/home/gpu',
  });
  insertEvent(DEMO_JOB.proteinCanceled, canceledStarted - minute, 'created', '任务已创建，等待调度');
  insertEvent(DEMO_JOB.proteinCanceled, canceledStarted, 'status', '任务已启动（tmux 会话）', {
    from: 'pending',
    to: 'running',
  });
  insertEvent(DEMO_JOB.proteinCanceled, canceledStarted + 8 * minute, 'stop', '用户停止任务（演示）');
  insertEvent(DEMO_JOB.proteinCanceled, canceledStarted + 8 * minute, 'status', '任务已停止', {
    from: 'running',
    to: 'canceled',
  });

  seedSyncRun({
    id: DEMO_RUN.proteinA100,
    projectId: DEMO_PROJECT.protein,
    projectName: '蛋白质结构预测',
    localDir: localRoot('protein-fold'),
    targetId: DEMO_TARGET.proteinA100,
    targetLabel: 'A100 · 主训练',
    serverId: DEMO_SERVER.a100,
    remoteDir: '/home/gpu/projects/protein-fold',
    dryRun: false,
    startedAt: now - 43 * minute,
    durationMs: 6200,
    counts: { add: 2, updateSize: 1, updateMtime: 0, same: 184, delete: 0, ignored: 61, protectedSkipped: 0, skippedSymlinks: 0 },
    bytes: { upload: 1_436_840, delete: 0, totalLocal: 12_685_312 },
  });
  seedSyncRun({
    id: DEMO_RUN.proteinCloud,
    projectId: DEMO_PROJECT.protein,
    projectName: '蛋白质结构预测',
    localDir: localRoot('protein-fold'),
    targetId: DEMO_TARGET.proteinCloud,
    targetLabel: '3090×2 · 对照实验',
    serverId: DEMO_SERVER.cloud,
    remoteDir: '/data/projects/protein-fold',
    dryRun: false,
    startedAt: now - 30 * minute,
    durationMs: 9800,
    counts: { add: 6, updateSize: 0, updateMtime: 2, same: 179, delete: 0, ignored: 61, protectedSkipped: 0, skippedSymlinks: 0 },
    bytes: { upload: 3_982_100, delete: 0, totalLocal: 12_685_312 },
  });
  seedSyncRun({
    id: DEMO_RUN.diffusion4090,
    projectId: DEMO_PROJECT.diffusion,
    projectName: '扩散模型 LoRA 微调',
    localDir: localRoot('diffusion-finetune'),
    targetId: DEMO_TARGET.diffusion4090,
    targetLabel: '4090 · LoRA',
    serverId: DEMO_SERVER.rtx4090,
    remoteDir: '/home/lab/diffusion',
    dryRun: false,
    startedAt: now - day - 2 * hour,
    durationMs: 7400,
    counts: { add: 4, updateSize: 2, updateMtime: 0, same: 258, delete: 0, ignored: 148, protectedSkipped: 0, skippedSymlinks: 0 },
    bytes: { upload: 2_144_300, delete: 0, totalLocal: 28_412_900 },
  });
  seedSyncRun({
    id: DEMO_RUN.proteinDryRun,
    projectId: DEMO_PROJECT.protein,
    projectName: '蛋白质结构预测',
    localDir: localRoot('protein-fold'),
    targetId: DEMO_TARGET.proteinA100,
    targetLabel: 'A100 · 主训练',
    serverId: DEMO_SERVER.a100,
    remoteDir: '/home/gpu/projects/protein-fold',
    dryRun: true,
    startedAt: now - 3 * hour,
    durationMs: 900,
    counts: { add: 0, updateSize: 2, updateMtime: 1, same: 184, delete: 0, ignored: 61, protectedSkipped: 0, skippedSymlinks: 0 },
    bytes: { upload: 640_000, delete: 0, totalLocal: 12_685_312 },
  });
}

function refreshRunningJobs(now: number): void {
  const offsets: Record<string, number> = {
    [DEMO_JOB.proteinRunning]: 40 * minute,
    [DEMO_JOB.diffusionRunning]: 57 * minute,
  };
  for (const id of DEMO_RUNNING_JOB_IDS) {
    prepare(
      `UPDATE jobs SET created_at = ?, started_at = ?, last_seen_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(now - (offsets[id] ?? 30 * minute) - minute, now - (offsets[id] ?? 30 * minute), now, id);
  }
}

export function seedDemoData(): void {
  const marker = prepare('SELECT value_json FROM settings WHERE key = ?').get(SEED_KEY);
  const now = Date.now();
  if (!marker) {
    seedAll(now);
    prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(SEED_KEY, JSON.stringify({ seededAt: new Date(now).toISOString() }), now);
    log.info('演示数据已载入（3 台服务器 / 2 个项目 / 4 个目标 / 5 条任务 / 4 条同步记录）');
  } else {
    log.info('演示数据已存在，跳过种子');
  }
  refreshRunningJobs(now);
}