import { randomUUID } from 'node:crypto';
import {
  TemplateError,
  type SftpSyncConfig,
  type SyncMode,
  type TargetDTO,
  type TargetInput,
  type TargetPreview,
  type TargetSyncConfig,
} from '@sm/shared';
import { prepare } from '../db/index.ts';
import { ApiError, notFound } from '../errors.ts';
import { buildJobScript } from '../jobs/script.ts';

export type TargetRow = {
  id: string;
  project_id: string;
  server_id: string;
  label: string | null;
  remote_code_dir: string;
  data_dir: string | null;
  conda_env: string | null;
  env_vars_json: string;
  pre_command: string | null;
  run_command: string;
  gpu_devices: string | null;
  sync_mode: string;
  sync_config_json: string;
  keep_session: number;
  created_at: number;
  updated_at: number;
  project_name?: string;
  server_name?: string;
  last_sync_at?: number | null;
};

const TARGET_SELECT = `
  SELECT t.*, p.name AS project_name, s.name AS server_name,
    (SELECT MAX(r.started_at) FROM sync_runs r WHERE r.target_id = t.id AND r.status = 'done') AS last_sync_at
  FROM targets t
  JOIN projects p ON p.id = t.project_id
  JOIN servers s ON s.id = t.server_id
`;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;
}

export function rowToDto(row: TargetRow): TargetDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    serverId: row.server_id,
    label: row.label,
    remoteCodeDir: row.remote_code_dir,
    dataDir: row.data_dir,
    condaEnv: row.conda_env,
    envVars: parseJson<Record<string, string>>(row.env_vars_json, {}),
    preCommand: row.pre_command,
    runCommand: row.run_command,
    gpuDevices: row.gpu_devices,
    syncMode: (row.sync_mode as SyncMode) ?? 'sftp',
    syncConfig: parseJson<TargetSyncConfig>(row.sync_config_json, {}),
    keepSession: Boolean(row.keep_session),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    projectName: row.project_name,
    serverName: row.server_name,
    lastSyncAt: iso(row.last_sync_at),
    lastJob: null,
  };
}

export function getTargetRow(id: string): TargetRow | undefined {
  return prepare(`${TARGET_SELECT} WHERE t.id = ?`).get(id) as unknown as TargetRow | undefined;
}

function requireTargetRow(id: string): TargetRow {
  const row = getTargetRow(id);
  if (!row) throw notFound('目标');
  return row;
}

export function listTargets(filter: { projectId?: string; serverId?: string } = {}): TargetDTO[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.projectId) {
    clauses.push('t.project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.serverId) {
    clauses.push('t.server_id = ?');
    params.push(filter.serverId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = prepare(`${TARGET_SELECT}${where} ORDER BY t.created_at ASC`).all(
    ...params,
  ) as unknown as TargetRow[];
  return rows.map(rowToDto);
}

export function getTargetDto(id: string): TargetDTO {
  return rowToDto(requireTargetRow(id));
}

function validateRemotePath(dir: string, label: string, minDepth: number): string {
  const trimmed = dir.trim();
  if (!trimmed.startsWith('/')) {
    throw new ApiError(400, 'REMOTE_PATH_INVALID', `${label}必须是绝对路径（以 / 开头）`);
  }
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new ApiError(400, 'REMOTE_PATH_INVALID', `${label}不能包含 . 或 .. 路径段`);
  }
  if (parts.length < minDepth) {
    throw new ApiError(
      400,
      'REMOTE_PATH_INVALID',
      `${label}路径过浅，请指向具体目录（例如 /home/me/project）`,
    );
  }
  return `/${parts.join('/')}`;
}

function normalizeEnvVars(vars: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(vars ?? {});
  if (entries.length > 64) {
    throw new ApiError(400, 'ENV_VAR_INVALID', '环境变量最多 64 个');
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new ApiError(400, 'ENV_VAR_INVALID', `环境变量名不合法：${key}`);
    }
    if (typeof value !== 'string') {
      throw new ApiError(400, 'ENV_VAR_INVALID', `环境变量 ${key} 的值必须是字符串`);
    }
    result[key] = value;
  }
  return result;
}

function normalizeSyncConfig(mode: SyncMode, cfg: TargetSyncConfig | undefined): TargetSyncConfig {
  const sftp: SftpSyncConfig = {
    mirrorDelete: cfg?.mirrorDelete ?? false,
    extraIgnores: (cfg?.extraIgnores ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 200),
    sizeOnly: cfg?.sizeOnly ?? false,
    preserveMode: cfg?.preserveMode ?? true,
    protectGlobs: (cfg?.protectGlobs ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 100),
  };
  if (mode === 'sftp') return sftp;
  return {
    ...sftp,
    remoteUrl: (cfg?.remoteUrl ?? '').trim(),
    branch: (cfg?.branch ?? 'main').trim() || 'main',
    remoteName: (cfg?.remoteName ?? 'origin').trim() || 'origin',
    sourceKind: cfg?.sourceKind === 'target' ? 'target' : 'local',
    sourceTargetId: cfg?.sourceTargetId ?? null,
    autoCommitOnSource: cfg?.autoCommitOnSource ?? true,
    cloneIfMissing: cfg?.cloneIfMissing ?? true,
    commitMessageTemplate:
      cfg?.commitMessageTemplate?.trim() || 'sm: {{project_name}} → {{server_name}}',
  };
}

type NormalizedTarget = {
  label: string | null;
  remoteCodeDir: string;
  dataDir: string | null;
  condaEnv: string | null;
  envVars: Record<string, string>;
  preCommand: string | null;
  runCommand: string;
  gpuDevices: string | null;
  syncMode: SyncMode;
  syncConfig: TargetSyncConfig;
  keepSession: boolean;
};

function normalizeTarget(input: TargetInput): NormalizedTarget {
  const remoteCodeDir = validateRemotePath(input.remoteCodeDir, '远程代码目录', 2);
  const dataDir = input.dataDir?.trim() ? validateRemotePath(input.dataDir, '数据目录', 1) : null;
  if (dataDir && dataDir === remoteCodeDir) {
    throw new ApiError(400, 'REMOTE_PATH_INVALID', '数据目录不能与远程代码目录相同');
  }
  const runCommand = input.runCommand.trim();
  if (!runCommand) throw new ApiError(400, 'VALIDATION_FAILED', '运行命令不能为空');
  const condaEnv = input.condaEnv?.trim() || null;
  if (condaEnv && /[\s'"]/.test(condaEnv)) {
    throw new ApiError(400, 'CONDA_ENV_INVALID', 'conda 环境名不能包含空格或引号');
  }
  const gpuDevices = input.gpuDevices?.trim() || null;
  if (gpuDevices && /[^0-9A-Za-z,._-]/.test(gpuDevices)) {
    throw new ApiError(400, 'GPU_DEVICES_INVALID', 'GPU 设备列表只允许数字、逗号、短横线与 GPU UUID 字符');
  }
  const syncMode: SyncMode = input.syncMode === 'git' ? 'git' : 'sftp';
  return {
    label: input.label?.trim() || null,
    remoteCodeDir,
    dataDir,
    condaEnv,
    envVars: normalizeEnvVars(input.envVars),
    preCommand: input.preCommand?.trim() || null,
    runCommand,
    gpuDevices,
    syncMode,
    syncConfig: normalizeSyncConfig(syncMode, input.syncConfig),
    keepSession: Boolean(input.keepSession),
  };
}

function requireProjectAndServer(projectId: string, serverId: string): { projectName: string; serverName: string } {
  const project = prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
    | { name: string }
    | undefined;
  if (!project) throw notFound('项目');
  const server = prepare('SELECT name FROM servers WHERE id = ?').get(serverId) as
    | { name: string }
    | undefined;
  if (!server) throw notFound('服务器');
  return { projectName: project.name, serverName: server.name };
}

function ensureTemplateValid(projectName: string, serverName: string, data: NormalizedTarget): void {
  try {
    buildJobScript({
      jobId: 'preview',
      projectName,
      serverName,
      target: {
        label: data.label,
        remoteCodeDir: data.remoteCodeDir,
        dataDir: data.dataDir,
        condaEnv: data.condaEnv,
        envVars: data.envVars,
        preCommand: data.preCommand,
        runCommand: data.runCommand,
        gpuDevices: data.gpuDevices,
      },
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      throw new ApiError(400, 'TEMPLATE_ERROR', err.message);
    }
    throw err;
  }
}

function mapUniqueError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('UNIQUE constraint failed: targets.project_id, targets.server_id')) {
    throw new ApiError(409, 'TARGET_EXISTS', '该服务器已绑定此项目，不能重复添加目标');
  }
  throw err;
}

function insertTarget(id: string, projectId: string, serverId: string, data: NormalizedTarget, now: number): void {
  prepare(
    `INSERT INTO targets
      (id, project_id, server_id, label, remote_code_dir, data_dir, conda_env, env_vars_json,
       pre_command, run_command, gpu_devices, sync_mode, sync_config_json, keep_session, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    serverId,
    data.label,
    data.remoteCodeDir,
    data.dataDir,
    data.condaEnv,
    JSON.stringify(data.envVars),
    data.preCommand,
    data.runCommand,
    data.gpuDevices,
    data.syncMode,
    JSON.stringify(data.syncConfig),
    data.keepSession ? 1 : 0,
    now,
    now,
  );
}

export function createTarget(input: TargetInput): TargetDTO {
  const { projectName, serverName } = requireProjectAndServer(input.projectId, input.serverId);
  const data = normalizeTarget(input);
  ensureTemplateValid(projectName, serverName, data);
  const id = randomUUID();
  try {
    insertTarget(id, input.projectId, input.serverId, data, Date.now());
  } catch (err) {
    mapUniqueError(err);
  }
  return getTargetDto(id);
}

export function updateTarget(id: string, patch: Partial<TargetInput>): TargetDTO {
  const row = requireTargetRow(id);
  const projectId = row.project_id;
  const serverId = row.server_id;
  const merged: TargetInput = {
    projectId,
    serverId,
    label: patch.label !== undefined ? patch.label : row.label,
    remoteCodeDir: patch.remoteCodeDir !== undefined ? patch.remoteCodeDir : row.remote_code_dir,
    dataDir: patch.dataDir !== undefined ? patch.dataDir : row.data_dir,
    condaEnv: patch.condaEnv !== undefined ? patch.condaEnv : row.conda_env,
    envVars:
      patch.envVars !== undefined
        ? patch.envVars
        : parseJson<Record<string, string>>(row.env_vars_json, {}),
    preCommand: patch.preCommand !== undefined ? patch.preCommand : row.pre_command,
    runCommand: patch.runCommand !== undefined ? patch.runCommand : row.run_command,
    gpuDevices: patch.gpuDevices !== undefined ? patch.gpuDevices : row.gpu_devices,
    syncMode: patch.syncMode !== undefined ? patch.syncMode : (row.sync_mode as SyncMode),
    syncConfig:
      patch.syncConfig !== undefined
        ? patch.syncConfig
        : parseJson<TargetSyncConfig>(row.sync_config_json, {}),
    keepSession: patch.keepSession !== undefined ? patch.keepSession : Boolean(row.keep_session),
  };
  const data = normalizeTarget(merged);
  const { projectName, serverName } = requireProjectAndServer(projectId, serverId);
  ensureTemplateValid(projectName, serverName, data);

  prepare(
    `UPDATE targets SET label = ?, remote_code_dir = ?, data_dir = ?, conda_env = ?, env_vars_json = ?,
       pre_command = ?, run_command = ?, gpu_devices = ?, sync_mode = ?, sync_config_json = ?,
       keep_session = ?, updated_at = ? WHERE id = ?`,
  ).run(
    data.label,
    data.remoteCodeDir,
    data.dataDir,
    data.condaEnv,
    JSON.stringify(data.envVars),
    data.preCommand,
    data.runCommand,
    data.gpuDevices,
    data.syncMode,
    JSON.stringify(data.syncConfig),
    data.keepSession ? 1 : 0,
    Date.now(),
    id,
  );
  return getTargetDto(id);
}

export function deleteTarget(id: string): { ok: true; deletedJobs: number } {
  requireTargetRow(id);
  const jobCount = Number(
    (prepare('SELECT COUNT(*) AS c FROM jobs WHERE target_id = ?').get(id) as { c: number }).c,
  );
  prepare('DELETE FROM targets WHERE id = ?').run(id);
  return { ok: true, deletedJobs: jobCount };
}

function buildPreview(projectName: string, serverName: string, data: NormalizedTarget): TargetPreview {
  try {
    const script = buildJobScript({
      jobId: 'preview',
      projectName,
      serverName,
      target: {
        label: data.label,
        remoteCodeDir: data.remoteCodeDir,
        dataDir: data.dataDir,
        condaEnv: data.condaEnv,
        envVars: data.envVars,
        preCommand: data.preCommand,
        runCommand: data.runCommand,
        gpuDevices: data.gpuDevices,
      },
    });
    return {
      renderedCommand: script.renderedCommand,
      scriptContent: script.scriptContent,
      warnings: script.warnings,
    };
  } catch (err) {
    if (err instanceof TemplateError) {
      throw new ApiError(400, 'TEMPLATE_ERROR', err.message);
    }
    throw err;
  }
}

export function previewTargetDraft(input: TargetInput): TargetPreview {
  const { projectName, serverName } = requireProjectAndServer(input.projectId, input.serverId);
  const data = normalizeTarget(input);
  return buildPreview(projectName, serverName, data);
}

export function previewTargetById(id: string): TargetPreview {
  const row = requireTargetRow(id);
  const data = normalizeTarget({
    projectId: row.project_id,
    serverId: row.server_id,
    label: row.label,
    remoteCodeDir: row.remote_code_dir,
    dataDir: row.data_dir,
    condaEnv: row.conda_env,
    envVars: parseJson<Record<string, string>>(row.env_vars_json, {}),
    preCommand: row.pre_command,
    runCommand: row.run_command,
    gpuDevices: row.gpu_devices,
    syncMode: row.sync_mode as SyncMode,
    syncConfig: parseJson<TargetSyncConfig>(row.sync_config_json, {}),
    keepSession: Boolean(row.keep_session),
  });
  return buildPreview(row.project_name ?? '', row.server_name ?? '', data);
}