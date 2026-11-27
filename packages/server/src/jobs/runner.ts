import { randomUUID } from 'node:crypto';
import type { JobDTO, JobInput, SyncRunStatus, TargetDTO } from '@sm/shared';
import { TemplateError } from '@sm/shared';
import { ApiError, notFound } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { runBus } from '../realtime/runbus.ts';
import {
  appendJobEvent,
  getJobDto,
  getJobRow,
  insertJob,
  transitionJob,
  updateJob,
  type JobRow,
} from '../services/jobs.ts';
import { getProjectRow } from '../services/projects.ts';
import { getServerRow } from '../services/servers.ts';
import { getSyncRunRow, isTerminalStatus } from '../services/sync.ts';
import { getTargetRow, type TargetRow } from '../services/targets.ts';
import { startSyncRun } from '../sync/engine.ts';
import { launchJob } from './launcher.ts';
import { buildJobScript } from './script.ts';
import { normalizeSessionRequest, type SessionRequest } from './session.ts';

const log = createLogger('job-runner');

const orchestrations = new Map<string, AbortController>();

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function defaultTitle(target: TargetRow, projectName: string): string {
  const now = new Date();
  const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${target.label || projectName} · ${stamp}`;
}

function validateTemplate(
  target: TargetRow,
  projectName: string,
  serverName: string,
  commandOverride?: string,
): void {
  try {
    buildJobScript({
      jobId: 'validate',
      projectName,
      serverName,
      commandOverride,
      target: {
        label: target.label,
        remoteCodeDir: target.remote_code_dir,
        dataDir: target.data_dir,
        condaEnv: target.conda_env,
        envVars: JSON.parse(target.env_vars_json || '{}') as Record<string, string>,
        preCommand: target.pre_command,
        runCommand: target.run_command,
        gpuDevices: target.gpu_devices,
      },
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      throw new ApiError(400, 'TEMPLATE_ERROR', err.message);
    }
    throw err;
  }
}

export function getOrchestration(jobId: string): AbortController | undefined {
  return orchestrations.get(jobId);
}

export function createJob(input: JobInput): JobDTO {
  const target = getTargetRow(input.targetId);
  if (!target) throw notFound('目标');
  if (input.syncFirst && target.sync_mode !== 'sftp') {
    throw new ApiError(400, 'SYNC_MODE_UNSUPPORTED', '当前阶段“先同步再运行”仅支持 SFTP 同步模式');
  }
  const project = getProjectRow(target.project_id);
  const server = getServerRow(target.server_id);
  if (!project) throw notFound('项目');
  if (!server) throw notFound('服务器');

  validateTemplate(target, project.name, server.name, input.command);

  const id = randomUUID();
  let sessionRequest: SessionRequest;
  try {
    sessionRequest = normalizeSessionRequest(id, input);
  } catch (err) {
    throw new ApiError(
      400,
      'INVALID_SESSION_MODE',
      err instanceof Error ? err.message : String(err),
    );
  }
  const command = input.command?.trim();
  insertJob({
    id,
    targetId: target.id,
    projectId: project.id,
    serverId: server.id,
    title: input.title?.trim() || defaultTitle(target, project.name),
    renderedCommand: command || target.run_command,
    launcher: sessionRequest.launcher,
    sessionMode: sessionRequest.sessionMode,
    sessionName: sessionRequest.sessionName,
    windowId: sessionRequest.windowId,
    windowName: sessionRequest.windowName,
  });

  const controller = new AbortController();
  orchestrations.set(id, controller);
  setImmediate(() => {
    void runJob(id, input, controller)
      .catch((err: unknown) => {
        log.error(`任务调度异常 ${id}`, {
          message: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      })
      .finally(() => {
        if (orchestrations.get(id) === controller) orchestrations.delete(id);
      });
  });

  return getJobDto(id);
}

function waitForSync(
  runId: string,
  signal: AbortSignal,
): Promise<{ status: SyncRunStatus; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const finish = (value: { status: SyncRunStatus; error: string | null }): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish({ status: 'canceled', error: '已取消' });

    unsubscribe = runBus.subscribe(runId, (event) => {
      if (event.data.type === 'done') {
        finish({ status: event.data.status, error: event.data.error ?? null });
      }
    });

    const row = getSyncRunRow(runId);
    if (row && isTerminalStatus(row.status as SyncRunStatus)) {
      finish({ status: row.status as SyncRunStatus, error: row.error });
      return;
    }
    if (signal.aborted) {
      finish({ status: 'canceled', error: '已取消' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function failedBeforeLaunch(row: JobRow, message: string): void {
  if (row.status === 'syncing') {
    transitionJob(row.id, 'sync_failed', {
      patch: { error: message, finishedAt: Date.now() },
      message: `同步失败：${message}`,
    });
    return;
  }
  if (row.status === 'pending' || row.status === 'starting') {
    transitionJob(row.id, 'start_failed', {
      patch: { error: message, finishedAt: Date.now() },
      message: `启动失败：${message}`,
    });
  }
}

async function runJob(jobId: string, input: JobInput, controller: AbortController): Promise<void> {
  let row = getJobRow(jobId);
  if (!row || row.status !== 'pending') return;

  try {
    if (input.syncFirst) {
      transitionJob(jobId, 'syncing', { message: '开始同步代码…' });
      let syncRunId: string;
      try {
        const run = startSyncRun({ targetId: input.targetId, dryRun: false });
        syncRunId = run.id;
        updateJob(jobId, { syncRunId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedBeforeLaunch(getJobRow(jobId) ?? row, message);
        return;
      }
      appendJobEvent(jobId, 'sync', `代码同步已开始（${syncRunId.slice(0, 8)}）`);
      const result = await waitForSync(syncRunId, controller.signal);
      const current = getJobRow(jobId);
      if (!current) return;
      if (controller.signal.aborted || current.status === 'canceled') return;
      if (result.status !== 'done') {
        const message = result.error || '代码同步未成功完成';
        if (current.status === 'syncing') {
          transitionJob(jobId, 'sync_failed', {
            patch: { error: message, finishedAt: Date.now() },
            message: `同步失败：${message}`,
          });
        }
        return;
      }
      appendJobEvent(jobId, 'sync', '代码同步完成');
    }

    row = getJobRow(jobId);
    if (!row || (row.status !== 'pending' && row.status !== 'syncing') || controller.signal.aborted) {
      return;
    }
    transitionJob(jobId, 'starting', { message: '正在上传任务脚本…' });
    await launchJob(jobId, input.launcher);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`任务准备失败 ${jobId}`, { message });
    const current = getJobRow(jobId);
    if (current && (current.status === 'pending' || current.status === 'syncing')) {
      try {
        failedBeforeLaunch(current, message);
      } catch (transitionErr) {
        log.warn(`写入失败状态失败 ${jobId}`, {
          message: transitionErr instanceof Error ? transitionErr.message : String(transitionErr),
        });
      }
    }
  }
}