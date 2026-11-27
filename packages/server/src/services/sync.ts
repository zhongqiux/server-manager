import type {
  GitRunSummary,
  SyncCounts,
  SyncDirection,
  SyncMode,
  SyncPlan,
  SyncRunDTO,
  SyncRunStatus,
} from '@sm/shared';
import { prepare } from '../db/index.ts';
import { notFound } from '../errors.ts';

export type SyncRunRow = {
  id: string;
  project_id: string;
  target_id: string | null;
  mode: string;
  direction: string;
  source_json: string;
  dest_json: string;
  dry_run: number;
  status: string;
  stats_json: string | null;
  plan_json: string | null;
  output_tail: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

type RunStats = {
  counts?: SyncCounts | null;
  bytes?: SyncRunDTO['bytes'];
  git?: GitRunSummary | null;
};

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

export function rowToSyncRunDto(row: SyncRunRow): SyncRunDTO {
  const stats = parseJson<RunStats>(row.stats_json, {});
  return {
    id: row.id,
    projectId: row.project_id,
    targetId: row.target_id,
    mode: row.mode as SyncMode,
    direction: row.direction as SyncDirection,
    dryRun: Boolean(row.dry_run),
    status: row.status as SyncRunStatus,
    counts: stats.counts ?? null,
    bytes: stats.bytes ?? null,
    plan: parseJson<SyncPlan | null>(row.plan_json, null),
    git: stats.git ?? null,
    outputTail: row.output_tail,
    error: row.error,
    startedAt: iso(row.started_at) ?? new Date(row.started_at).toISOString(),
    finishedAt: iso(row.finished_at),
  };
}

const TERMINAL_STATUSES = new Set<SyncRunStatus>(['done', 'failed', 'canceled']);

export function isTerminalStatus(status: SyncRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function getSyncRunRow(id: string): SyncRunRow | undefined {
  return prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as unknown as SyncRunRow | undefined;
}

export function getSyncRunDto(id: string): SyncRunDTO {
  const row = getSyncRunRow(id);
  if (!row) throw notFound('同步记录');
  return rowToSyncRunDto(row);
}

export function listSyncRuns(filter: {
  targetId?: string;
  projectId?: string;
  limit?: number;
}): SyncRunDTO[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.targetId) {
    clauses.push('target_id = ?');
    params.push(filter.targetId);
  }
  if (filter.projectId) {
    clauses.push('project_id = ?');
    params.push(filter.projectId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
  const rows = prepare(`SELECT * FROM sync_runs${where} ORDER BY started_at DESC LIMIT ?`).all(
    ...params,
    limit,
  ) as unknown as SyncRunRow[];
  return rows.map(rowToSyncRunDto);
}

export type SyncRunPatch = {
  status?: SyncRunStatus;
  statsJson?: string | null;
  planJson?: string | null;
  outputTail?: string | null;
  error?: string | null;
  finishedAt?: number | null;
};

export function updateSyncRun(id: string, patch: SyncRunPatch): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.statsJson !== undefined) {
    sets.push('stats_json = ?');
    params.push(patch.statsJson);
  }
  if (patch.planJson !== undefined) {
    sets.push('plan_json = ?');
    params.push(patch.planJson);
  }
  if (patch.outputTail !== undefined) {
    sets.push('output_tail = ?');
    params.push(patch.outputTail);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?');
    params.push(patch.finishedAt);
  }
  if (sets.length === 0) return;
  params.push(id);
  prepare(`UPDATE sync_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}