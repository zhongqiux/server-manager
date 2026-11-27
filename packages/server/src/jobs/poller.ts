import type { JobStatus } from '@sm/shared';
import { isDemoId } from '../demo/ids.ts';
import { createLogger } from '../logger.ts';
import {
  getJobRow,
  isTerminalStatus,
  listActiveJobRows,
  transitionJob,
  updateJob,
  type JobRow,
} from '../services/jobs.ts';
import { getTargetRow } from '../services/targets.ts';
import { logHub } from './loghub.ts';
import { probeJob, type JobProbe } from './probe.ts';
import { isSessionLauncher, normalizeSessionMode } from './session.ts';
import { cleanupOwnedTarget } from './session-actions.ts';
import { isJobStopping } from './stop.ts';
import { applyExitResult } from './terminal.ts';

const log = createLogger('job-poller');

const TICK_MS = 1000;
const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 5000;
const FAST_WINDOW_MS = 30_000;
const LOST_GRACE_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
const lastPollAt = new Map<string, number>();
const inflight = new Set<string>();
const errorLogAt = new Map<string, number>();

function warnThrottled(jobId: string, message: string): void {
  const now = Date.now();
  if (now - (errorLogAt.get(jobId) ?? 0) < 60_000) return;
  errorLogAt.set(jobId, now);
  log.warn(`任务探测失败 ${jobId}`, { message });
}

async function handleExit(job: JobRow, probe: JobProbe): Promise<void> {
  applyExitResult(job, probe);
  void logHub.notifyTerminal(job.id);
  const target = getTargetRow(job.target_id);
  if (!target?.keep_session) await cleanupOwnedTarget(job);
}

function missingEvidence(job: JobRow, probe: JobProbe): boolean {
  const mode = normalizeSessionMode(job.session_mode);
  if (mode === 'new_window' || mode === 'existing_window') {
    return Boolean(job.remote_pid) && probe.alive === false;
  }
  if (isSessionLauncher(job.launcher)) {
    if (probe.session === false) return true;
    return Boolean(job.remote_pid) && probe.alive === false;
  }
  if (job.launcher === 'nohup') return probe.alive === false;
  return false;
}

async function pollOne(row: JobRow): Promise<void> {
  const fresh = getJobRow(row.id);
  if (!fresh || isTerminalStatus(fresh.status)) return;

  let probe: JobProbe;
  try {
    probe = await probeJob(fresh);
  } catch (err) {
    warnThrottled(fresh.id, err instanceof Error ? err.message : String(err));
    return;
  }

  if (probe.exitFound) {
    await handleExit(fresh, probe);
    return;
  }

  if (fresh.status === 'starting') {
    if (probe.alive === true) {
      transitionJob(fresh.id, 'running', {
        patch: { startedAt: fresh.started_at ?? Date.now(), lastSeenAt: Date.now() },
        message: '检测到任务已在远程运行',
      });
    } else if (Date.now() - fresh.created_at > START_TIMEOUT_MS) {
      transitionJob(fresh.id, 'start_failed', {
        patch: {
          error: '启动超时：未找到远程任务进程',
          finishedAt: Date.now(),
        },
        message: '启动超时',
      });
      void logHub.notifyTerminal(fresh.id);
    }
    return;
  }

  updateJob(fresh.id, {
    logBytes: probe.logSize ?? fresh.log_bytes,
    lastSeenAt: Date.now(),
  });

  if (missingEvidence(fresh, probe)) {
    const since = fresh.started_at ?? fresh.created_at;
    if (Date.now() - since > LOST_GRACE_MS) {
      transitionJob(fresh.id, 'lost', {
        patch: {
          error: normalizeSessionMode(fresh.session_mode) === 'new' && isSessionLauncher(fresh.launcher)
            ? `${fresh.launcher} 会话已消失，且未写入退出码`
            : '任务进程已消失，且未写入退出码',
          finishedAt: Date.now(),
        },
        message: '任务状态丢失（会话/进程消失且无退出码）',
      });
      void logHub.notifyTerminal(fresh.id);
    }
  }
}

function scheduleTick(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref();
}

async function tick(): Promise<void> {
  let rows: JobRow[];
  try {
    rows = listActiveJobRows();
  } catch (err) {
    log.error('任务轮询查询失败', { message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const now = Date.now();
  const seen = new Set(rows.map((row) => row.id));
  for (const id of [...lastPollAt.keys()]) {
    if (!seen.has(id)) {
      lastPollAt.delete(id);
      errorLogAt.delete(id);
    }
  }

  for (const row of rows) {
    if (isDemoId(row.server_id)) continue;
    const status = row.status as JobStatus;
    if (status !== 'running' && status !== 'starting') continue;
    if (isJobStopping(row.id) || inflight.has(row.id)) continue;
    const interval = now - row.created_at < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
    if (now - (lastPollAt.get(row.id) ?? 0) < interval) continue;
    lastPollAt.set(row.id, now);
    inflight.add(row.id);
    void pollOne(row)
      .catch((err: unknown) => {
        warnThrottled(row.id, err instanceof Error ? err.message : String(err));
      })
      .finally(() => inflight.delete(row.id));
  }
}

export function startJobPoller(): void {
  scheduleTick();
}

export function stopJobPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastPollAt.clear();
  errorLogAt.clear();
  inflight.clear();
}

export function recoverInterruptedJobs(): void {
  const rows = listActiveJobRows();
  let recovered = 0;
  for (const row of rows) {
    try {
      if (row.status === 'pending') {
        transitionJob(row.id, 'start_failed', {
          patch: { error: '服务重启，任务未能启动', finishedAt: Date.now() },
          message: '服务重启，任务未能启动',
        });
        recovered += 1;
      } else if (row.status === 'syncing') {
        transitionJob(row.id, 'sync_failed', {
          patch: { error: '服务重启，同步流程中断', finishedAt: Date.now() },
          message: '服务重启，同步中断',
        });
        recovered += 1;
      }
    } catch (err) {
      log.warn(`恢复任务状态失败 ${row.id}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (recovered > 0) log.info(`已恢复 ${recovered} 个中断任务的状态`);
}