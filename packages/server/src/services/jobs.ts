import type {
  JobDTO,
  JobEventDTO,
  JobLauncher,
  JobSessionMode,
  JobStatus,
} from '@sm/shared';
import { JOB_SESSION_MODES, canTransitionJob, isJobActive, isJobTerminal, jobStatusLabel } from '@sm/shared';
import { prepare } from '../db/index.ts';
import { notFound } from '../errors.ts';
import { publishGlobal } from '../realtime/events-bus.ts';

export type JobRow = {
  id: string;
  target_id: string;
  project_id: string;
  server_id: string;
  title: string;
  status: string;
  launcher: string | null;
  session_name: string | null;
  session_mode: string;
  window_id: string | null;
  window_name: string | null;
  remote_pid: number | null;
  remote_pgid: number | null;
  script_path: string | null;
  log_path: string | null;
  exit_path: string | null;
  rendered_command: string;
  script_content: string;
  exit_code: number | null;
  error: string | null;
  sync_run_id: string | null;
  log_bytes: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_seen_at: number | null;
  project_name?: string;
  server_name?: string;
  target_label?: string | null;
};

const JOB_SELECT = `
  SELECT j.*, j.tmux_session AS session_name,
    p.name AS project_name, s.name AS server_name, t.label AS target_label
  FROM jobs j
  LEFT JOIN projects p ON p.id = j.project_id
  LEFT JOIN servers s ON s.id = j.server_id
  LEFT JOIN targets t ON t.id = j.target_id
`;

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function rowToJobDto(row: JobRow): JobDTO {
  return {
    id: row.id,
    targetId: row.target_id,
    projectId: row.project_id,
    serverId: row.server_id,
    title: row.title,
    status: row.status as JobStatus,
    launcher:
      row.launcher === 'tmux' || row.launcher === 'screen' || row.launcher === 'nohup'
        ? (row.launcher as JobLauncher)
        : null,
    sessionName: row.session_name,
    sessionMode: JOB_SESSION_MODES.includes(row.session_mode as JobSessionMode)
      ? (row.session_mode as JobSessionMode)
      : 'new',
    windowId: row.window_id,
    windowName: row.window_name,
    remotePid: row.remote_pid,
    remotePgid: row.remote_pgid,
    scriptPath: row.script_path,
    logPath: row.log_path,
    exitPath: row.exit_path,
    renderedCommand: row.rendered_command,
    scriptContent: row.script_content,
    exitCode: row.exit_code,
    error: row.error,
    syncRunId: row.sync_run_id,
    logBytes: row.log_bytes,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    lastSeenAt: iso(row.last_seen_at),
    projectName: row.project_name,
    serverName: row.server_name,
    targetLabel: row.target_label,
  };
}

export function getJobRow(id: string): JobRow | undefined {
  return prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as unknown as JobRow | undefined;
}

export function requireJobRow(id: string): JobRow {
  const row = getJobRow(id);
  if (!row) throw notFound('任务');
  return row;
}

export function listJobEvents(jobId: string, limit = 300): JobEventDTO[] {
  const rows = prepare(
    'SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC LIMIT ?',
  ).all(jobId, limit) as unknown as {
    id: number;
    job_id: string;
    ts: number;
    kind: string;
    message: string | null;
    data_json: string | null;
  }[];
  return rows.map((row) => ({
    id: Number(row.id),
    jobId: row.job_id,
    ts: new Date(row.ts).toISOString(),
    kind: row.kind,
    message: row.message,
    data: parseJson<unknown>(row.data_json, null),
  }));
}

export function getJobDto(id: string, options: { events?: boolean } = {}): JobDTO {
  const row = requireJobRow(id);
  const dto = rowToJobDto(row);
  if (options.events) dto.events = listJobEvents(id);
  return dto;
}

export type JobFilter = {
  active?: boolean;
  status?: JobStatus;
  targetId?: string;
  projectId?: string;
  serverId?: string;
  limit?: number;
};

const ACTIVE_SQL = `('pending', 'syncing', 'starting', 'running')`;
const TERMINAL_SQL = `('exited', 'failed', 'canceled', 'lost', 'sync_failed', 'start_failed')`;

export function listJobs(filter: JobFilter = {}): JobDTO[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.active === true) clauses.push(`j.status IN ${ACTIVE_SQL}`);
  if (filter.active === false) clauses.push(`j.status IN ${TERMINAL_SQL}`);
  if (filter.status) {
    clauses.push('j.status = ?');
    params.push(filter.status);
  }
  if (filter.targetId) {
    clauses.push('j.target_id = ?');
    params.push(filter.targetId);
  }
  if (filter.projectId) {
    clauses.push('j.project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.serverId) {
    clauses.push('j.server_id = ?');
    params.push(filter.serverId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = prepare(`${JOB_SELECT}${where} ORDER BY j.created_at DESC LIMIT ?`).all(
    ...params,
    limit,
  ) as unknown as JobRow[];
  return rows.map(rowToJobDto);
}

export function listActiveJobRows(): JobRow[] {
  return prepare(`${JOB_SELECT} WHERE j.status IN ${ACTIVE_SQL} ORDER BY j.created_at ASC`).all() as unknown as JobRow[];
}

export type InsertJobInput = {
  id: string;
  targetId: string;
  projectId: string;
  serverId: string;
  title: string;
  renderedCommand: string;
  syncRunId?: string | null;
  launcher?: JobLauncher | null;
  sessionMode?: JobSessionMode;
  sessionName?: string | null;
  windowId?: string | null;
  windowName?: string | null;
};

export function insertJob(input: InsertJobInput): void {
  const now = Date.now();
  prepare(
    `INSERT INTO jobs
       (id, target_id, project_id, server_id, title, status, rendered_command, script_content,
        sync_run_id, launcher, tmux_session, session_mode, window_id, window_name, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.targetId,
    input.projectId,
    input.serverId,
    input.title,
    input.renderedCommand,
    input.syncRunId ?? null,
    input.launcher ?? null,
    input.sessionName ?? null,
    input.sessionMode ?? 'new',
    input.windowId ?? null,
    input.windowName ?? null,
    now,
  );
  appendJobEvent(input.id, 'created', '任务已创建，等待调度');
}

export type JobPatch = {
  status?: JobStatus;
  launcher?: JobLauncher | null;
  sessionName?: string | null;
  sessionMode?: JobSessionMode;
  windowId?: string | null;
  windowName?: string | null;
  remotePid?: number | null;
  remotePgid?: number | null;
  scriptPath?: string | null;
  logPath?: string | null;
  exitPath?: string | null;
  renderedCommand?: string;
  scriptContent?: string;
  exitCode?: number | null;
  error?: string | null;
  syncRunId?: string | null;
  logBytes?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastSeenAt?: number | null;
};

const PATCH_COLUMNS: Record<keyof JobPatch, string> = {
  status: 'status',
  launcher: 'launcher',
  sessionName: 'tmux_session',
  sessionMode: 'session_mode',
  windowId: 'window_id',
  windowName: 'window_name',
  remotePid: 'remote_pid',
  remotePgid: 'remote_pgid',
  scriptPath: 'script_path',
  logPath: 'log_path',
  exitPath: 'exit_path',
  renderedCommand: 'rendered_command',
  scriptContent: 'script_content',
  exitCode: 'exit_code',
  error: 'error',
  syncRunId: 'sync_run_id',
  logBytes: 'log_bytes',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  lastSeenAt: 'last_seen_at',
};

export function updateJob(id: string, patch: JobPatch): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const key of Object.keys(patch) as (keyof JobPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    params.push(value as string | number | null);
  }
  if (sets.length === 0) return;
  params.push(id);
  prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function appendJobEvent(
  jobId: string,
  kind: string,
  message: string | null,
  data?: unknown,
): void {
  prepare('INSERT INTO job_events (job_id, ts, kind, message, data_json) VALUES (?, ?, ?, ?, ?)').run(
    jobId,
    Date.now(),
    kind,
    message,
    data === undefined ? null : JSON.stringify(data),
  );
}

function notifyStatus(row: JobRow): void {
  publishGlobal({
    type: 'job.status',
    jobId: row.id,
    status: row.status as JobStatus,
    exitCode: row.exit_code,
  });
}

export type TransitionOptions = {
  patch?: JobPatch;
  message?: string | null;
  data?: unknown;
};

// 状态机是任务可靠性的核心：所有写状态的地方都必须经过这里，
// 非法转移直接抛错，避免竞态（如停止与自然退出同时发生）悄悄写坏状态。
export function transitionJob(id: string, to: JobStatus, options: TransitionOptions = {}): JobRow | null {
  const row = getJobRow(id);
  if (!row) return null;
  const from = row.status as JobStatus;
  if (from === to) {
    const { status: _ignored, ...rest } = options.patch ?? {};
    void _ignored;
    if (Object.keys(rest).length > 0) updateJob(id, rest);
    return getJobRow(id) ?? null;
  }
  if (!canTransitionJob(from, to)) {
    throw new Error(`非法任务状态转移：${from} → ${to}（任务 ${id}）`);
  }
  const patch = options.patch ?? {};
  updateJob(id, { ...patch, status: to });
  appendJobEvent(
    id,
    'status',
    options.message ?? `${jobStatusLabel(from)} → ${jobStatusLabel(to)}`,
    { from, to, ...(typeof options.data === 'object' && options.data !== null ? options.data : {}) },
  );
  const fresh = getJobRow(id);
  if (fresh) notifyStatus(fresh);
  return fresh ?? null;
}

export function tryTransitionJob(
  id: string,
  to: JobStatus,
  options: TransitionOptions = {},
): JobRow | null {
  const row = getJobRow(id);
  if (!row) return null;
  if (!canTransitionJob(row.status as JobStatus, to)) return row;
  return transitionJob(id, to, options);
}

export function isActiveStatus(status: string): boolean {
  return isJobActive(status as JobStatus);
}

export function isTerminalStatus(status: string): boolean {
  return isJobTerminal(status as JobStatus);
}