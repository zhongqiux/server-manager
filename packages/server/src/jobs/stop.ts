import type { JobDTO } from '@sm/shared';
import { ApiError } from '../errors.ts';
import { createLogger } from '../logger.ts';
import {
  appendJobEvent,
  getJobDto,
  getJobRow,
  isTerminalStatus,
  requireJobRow,
  transitionJob,
  updateJob,
  type JobRow,
} from '../services/jobs.ts';
import { getTargetRow } from '../services/targets.ts';
import { cancelSyncRun } from '../sync/engine.ts';
import { getOrchestration } from './runner.ts';
import { logHub } from './loghub.ts';
import { execOnJobServer, probeJob, type JobProbe } from './probe.ts';
import { isSessionLauncher, normalizeSessionMode } from './session.ts';
import { cleanupOwnedTarget, interruptJobTarget } from './session-actions.ts';
import { applyExitResult } from './terminal.ts';

const log = createLogger('job-stop');

const activeStops = new Set<string>();

export function isJobStopping(jobId: string): boolean {
  return activeStops.has(jobId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeProbe(row: JobRow): Promise<JobProbe | null> {
  try {
    return await probeJob(row);
  } catch {
    return null;
  }
}

async function isAlive(row: JobRow): Promise<boolean> {
  if (!row.remote_pid) return false;
  const result = await execOnJobServer(
    row,
    `kill -0 ${row.remote_pid} 2>/dev/null && echo ALIVE=1 || echo ALIVE=0`,
    8000,
  );
  return /ALIVE=1/.test(result.stdout);
}

type PgidCheck = { state: 'ok' | 'gone' | 'mismatch'; pgid: number | null };

async function checkPgid(row: JobRow): Promise<PgidCheck> {
  if (!row.remote_pid) return { state: 'gone', pgid: null };
  const result = await execOnJobServer(
    row,
    `if kill -0 ${row.remote_pid} 2>/dev/null; then echo ALIVE=1; else echo ALIVE=0; fi; ps -o pgid= -p ${row.remote_pid} 2>/dev/null | tr -d ' '`,
    10_000,
  );
  if (!/ALIVE=1/.test(result.stdout)) return { state: 'gone', pgid: null };
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .find((item) => /^\d+$/.test(item));
  const pgid = line ? Number(line) : null;
  if (pgid === null) return { state: 'mismatch', pgid: null };
  if (row.remote_pgid && pgid !== row.remote_pgid) return { state: 'mismatch', pgid };
  return { state: 'ok', pgid };
}

async function cleanupAfterStop(row: JobRow): Promise<void> {
  try {
    await cleanupOwnedTarget(row);
  } catch {
    // 会话或窗口可能已不存在
  }
}

function finishCanceled(row: JobRow): void {
  const fresh = getJobRow(row.id);
  if (!fresh || isTerminalStatus(fresh.status)) return;
  try {
    transitionJob(row.id, 'canceled', {
      patch: { finishedAt: Date.now(), error: null },
      message: '任务已停止',
    });
  } catch (err) {
    log.warn(`写入停止状态失败 ${row.id}`, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  void logHub.notifyTerminal(row.id);
}

function finishFromExit(row: JobRow, probe: JobProbe): void {
  applyExitResult(row, probe);
  void logHub.notifyTerminal(row.id);
}

async function runStopSequence(jobId: string, force: boolean): Promise<void> {
  const append = (message: string): void => {
    appendJobEvent(jobId, 'stop', message);
  };
  try {
    let row = getJobRow(jobId);
    if (!row || isTerminalStatus(row.status)) return;

    if (row.status === 'starting') {
      append('等待启动流程完成，以便获取远程进程信息…');
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const fresh = getJobRow(jobId);
        if (!fresh || isTerminalStatus(fresh.status)) return;
        if (fresh.status !== 'starting') {
          row = fresh;
          break;
        }
        await sleep(500);
      }
      row = getJobRow(jobId) ?? row;
      if (row.status === 'starting') {
        getOrchestration(jobId)?.abort();
        append('启动流程超时，继续尝试远程停止');
        failStop(row, '启动流程超时，未能获取远程进程信息，停止中止');
        return;
      }
    }

    if (!force && isSessionLauncher(row.launcher) && row.session_name) {
      const mode = normalizeSessionMode(row.session_mode);
      const target =
        mode === 'new'
          ? `${row.launcher} 会话`
          : `${row.launcher} 窗口${row.window_id ? ` ${row.window_id}` : ''}`;
      append(`步骤 1/5：向${target}发送 Ctrl-C`);
      await interruptJobTarget(row);
      await sleep(5000);
      let probe = await safeProbe(row);
      if (probe?.exitFound) {
        finishFromExit(row, probe);
        return;
      }
      if (mode === 'existing_window') {
        append('步骤 2/5：已有窗口不属于本工具管理，保留窗口并继续终止任务进程');
      } else {
        append(
          mode === 'new'
            ? `步骤 2/5：关闭本工具新建的 ${row.launcher} 会话`
            : '步骤 2/5：关闭本工具新建的窗口',
        );
        await cleanupAfterStop(row);
        await sleep(2000);
        probe = await safeProbe(row);
        if (probe?.exitFound) {
          finishFromExit(row, probe);
          return;
        }
      }
    }

    if (!row.remote_pid) {
      const probe = await safeProbe(row);
      if (probe?.exitFound) {
        finishFromExit(row, probe);
        return;
      }
      if (probe && probe.session !== true && probe.alive !== true) {
        await cleanupAfterStop(row);
        append('步骤 5/5：会话与进程均已不存在，任务视为已停止');
        finishCanceled(row);
        return;
      }
      failStop(row, '缺少远程进程信息，无法终止任务');
      return;
    }

    const guard = await checkPgid(row);
    if (guard.state === 'gone') {
      const probe = await safeProbe(row);
      if (probe?.exitFound) {
        finishFromExit(row, probe);
        return;
      }
      await cleanupAfterStop(row);
      append('步骤 5/5：进程已不存在，任务视为已停止');
      finishCanceled(row);
      return;
    }
    if (guard.state === 'mismatch') {
      failStop(
        row,
        `进程组已变化（记录 ${row.remote_pgid ?? '未知'}，当前 ${guard.pgid ?? '未知'}），为避免误杀已停止操作`,
      );
      return;
    }

    const pgid = guard.pgid ?? row.remote_pgid;
    if (pgid) {
      append(`步骤 3/5：向进程组 ${pgid} 发送 SIGTERM`);
      await execOnJobServer(row, `kill -TERM -- -${pgid} 2>/dev/null || true`, 8000);
      await sleep(5000);
      let probe = await safeProbe(row);
      if (probe?.exitFound) {
        finishFromExit(row, probe);
        return;
      }
      if (!(await isAlive(row))) {
        append('进程已响应 SIGTERM');
      } else {
        append(`步骤 4/5：向进程组 ${pgid} 发送 SIGKILL`);
        await execOnJobServer(row, `kill -KILL -- -${pgid} 2>/dev/null || true`, 8000);
        await sleep(1000);
      }
    } else {
      append('没有进程组信息，改为终止单个进程');
      await execOnJobServer(row, `kill -TERM ${row.remote_pid} 2>/dev/null || true`, 8000);
      await sleep(3000);
      if (await isAlive(row)) {
        await execOnJobServer(row, `kill -KILL ${row.remote_pid} 2>/dev/null || true`, 8000);
        await sleep(1000);
      }
    }

    const finalProbe = await safeProbe(row);
    if (finalProbe?.exitFound) {
      finishFromExit(row, finalProbe);
      return;
    }
    if (finalProbe?.alive) {
      failStop(row, '步骤 5/5：进程仍在运行，请稍后重试强制停止');
      return;
    }
    await cleanupAfterStop(row);
    append('步骤 5/5：已确认任务停止');
    finishCanceled(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`停止任务失败 ${jobId}`, { message });
    appendJobEvent(jobId, 'stop', `停止失败：${message}`);
  }
}

function failStop(row: JobRow, message: string): void {
  appendJobEvent(row.id, 'stop', message);
  const fresh = getJobRow(row.id);
  if (fresh && !isTerminalStatus(fresh.status)) {
    // 保持原状态（任务可能仍在运行），只记录错误信息供 UI 展示
    updateJob(row.id, { error: message });
  }
}

export function stopJob(jobId: string, force: boolean): JobDTO {
  let row = requireJobRow(jobId);
  if (isTerminalStatus(row.status)) {
    throw new ApiError(409, 'JOB_NOT_RUNNING', '任务已结束，无法停止');
  }
  if (activeStops.has(jobId)) {
    throw new ApiError(409, 'STOP_IN_PROGRESS', '停止流程正在进行');
  }

  if (row.status === 'pending' || row.status === 'syncing') {
    getOrchestration(jobId)?.abort();
    if (row.sync_run_id) {
      try {
        cancelSyncRun(row.sync_run_id);
      } catch {
        // 同步可能已结束
      }
    }
    try {
      transitionJob(jobId, 'canceled', {
        patch: { finishedAt: Date.now(), error: null },
        message: '任务已取消（尚未启动）',
      });
    } catch {
      // 状态可能已进入 starting
    }
    const fresh = getJobRow(jobId);
    if (!fresh || isTerminalStatus(fresh.status)) return getJobDto(jobId);
    row = fresh;
  }

  activeStops.add(jobId);
  appendJobEvent(jobId, 'stop', force ? '收到强制停止请求' : '收到停止请求');
  setImmediate(() => {
    void runStopSequence(jobId, force)
      .catch((err: unknown) => {
        log.error(`停止流程异常 ${jobId}`, {
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => activeStops.delete(jobId));
  });
  return getJobDto(jobId);
}