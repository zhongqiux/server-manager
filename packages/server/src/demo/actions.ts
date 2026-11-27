import { randomUUID } from 'node:crypto';
import type { JobDTO, JobInput, JobLauncher } from '@sm/shared';
import { isJobTerminal, JOB_SESSION_MODE_LABELS, type JobStatus } from '@sm/shared';
import { ApiError, notFound } from '../errors.ts';
import { getProjectRow } from '../services/projects.ts';
import { getServerRow } from '../services/servers.ts';
import { getTargetRow } from '../services/targets.ts';
import {
  chooseJobLauncher,
  isSessionLauncher,
  jobSessionName,
  normalizeSessionMode,
  normalizeSessionRequest,
  type SessionRequest,
} from '../jobs/session.ts';
import {
  appendJobEvent,
  getJobDto,
  getJobRow,
  insertJob,
  transitionJob,
  updateJob,
} from '../services/jobs.ts';
import { demoNotifyJobTerminal } from './logs.ts';

const demoJobTimers = new Map<string, NodeJS.Timeout[]>();

function clearDemoJobTimers(jobId: string): void {
  for (const timer of demoJobTimers.get(jobId) ?? []) clearTimeout(timer);
  demoJobTimers.delete(jobId);
}

function defaultTitle(targetLabel: string | null, projectName: string): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${targetLabel || projectName} · ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function createDemoJob(input: JobInput): JobDTO {
  const target = getTargetRow(input.targetId);
  if (!target) throw notFound('目标');
  const project = getProjectRow(target.project_id);
  const server = getServerRow(target.server_id);
  if (!project) throw notFound('项目');
  if (!server) throw notFound('服务器');

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
  const mode = sessionRequest.sessionMode;

  let launcher: JobLauncher;
  let plannedSession: string | null = null;
  if (mode === 'new') {
    launcher = chooseJobLauncher(input.launcher, { tmux: true, screen: true });
    if (isSessionLauncher(launcher)) plannedSession = jobSessionName(id);
  } else {
    if (!sessionRequest.launcher) {
      throw new ApiError(400, 'INVALID_SESSION_MODE', '已有会话任务缺少启动工具');
    }
    launcher = sessionRequest.launcher;
    plannedSession = sessionRequest.sessionName;
  }

  let windowId = sessionRequest.windowId;
  let windowName = sessionRequest.windowName;
  if (mode === 'new_window') {
    windowId = launcher === 'tmux' ? `@${9 + Math.floor(Math.random() * 20)}` : '2';
  }

  const command = input.command?.trim() || target.run_command;
  insertJob({
    id,
    targetId: target.id,
    projectId: project.id,
    serverId: server.id,
    title: input.title?.trim() || defaultTitle(target.label, project.name),
    renderedCommand: command,
    launcher: mode === 'new' ? null : launcher,
    sessionMode: mode,
    sessionName: sessionRequest.sessionName,
    windowId,
    windowName,
  });

  const windowLabel = windowName ?? (windowId ? `#${windowId}` : '');
  const launchEvent =
    mode === 'existing_window'
      ? `演示模式：向 ${launcher} 会话 ${plannedSession} 的窗口 ${windowLabel} 注入任务脚本`
      : mode === 'new_window'
        ? `演示模式：在 ${launcher} 会话 ${plannedSession} 新开窗口 ${windowLabel} 并启动任务`
        : plannedSession
          ? `演示模式：模拟上传脚本并创建 ${launcher} 会话 ${plannedSession}`
          : '演示模式：模拟上传脚本并以 nohup 后台进程运行';
  appendJobEvent(id, 'launch', launchEvent);

  const timers: NodeJS.Timeout[] = [];
  timers.push(
    setTimeout(() => {
      const row = getJobRow(id);
      if (!row || row.status !== 'pending') return;
      transitionJob(id, 'starting', { message: '演示模式：正在连接服务器并启动会话…' });
    }, 900),
  );
  timers.push(
    setTimeout(() => {
      const row = getJobRow(id);
      if (!row || row.status !== 'starting') return;
      const pid = 120_000 + Math.floor(Math.random() * 60_000);
      updateJob(id, {
        launcher,
        sessionMode: mode,
        sessionName: plannedSession,
        windowId,
        windowName,
        remotePid: pid,
        remotePgid: pid,
        scriptPath: `/home/${server.username}/.server_manager/jobs/${id.slice(0, 8)}.sh`,
        logPath: `/home/${server.username}/.server_manager/logs/${id.slice(0, 8)}.log`,
        exitPath: `/home/${server.username}/.server_manager/logs/${id.slice(0, 8)}.exit`,
        logBytes: 0,
      });
      transitionJob(id, 'running', {
        patch: { startedAt: Date.now(), lastSeenAt: Date.now() },
        message: `演示模式：任务已启动（${JOB_SESSION_MODE_LABELS[mode]} · ${launcher}）`,
      });
    }, 2300),
  );
  demoJobTimers.set(id, timers);
  return getJobDto(id);
}

export function stopDemoJob(jobId: string, force: boolean): JobDTO {
  const job = getJobRow(jobId);
  if (!job) throw notFound('任务');
  if (isJobTerminal(job.status as JobStatus)) {
    throw new ApiError(409, 'JOB_TERMINAL', '任务已结束，无法停止');
  }
  clearDemoJobTimers(jobId);
  const mode = normalizeSessionMode(job.session_mode);
  let detail: string;
  if (force) {
    detail = '演示模式：直接终止任务进程组';
  } else if (mode === 'existing_window') {
    detail = `演示模式：向窗口 ${job.window_name ?? (job.window_id ? `#${job.window_id}` : '')} 发送 Ctrl-C（保留会话与窗口）`;
  } else if (job.launcher === 'nohup') {
    detail = '演示模式：向后台进程发送 SIGTERM';
  } else if (mode === 'new_window') {
    detail = `演示模式：向 ${job.launcher ?? '远程'} 会话 ${job.session_name ?? ''} 中的任务窗口发送 Ctrl-C`;
  } else {
    detail = `演示模式：发送 Ctrl-C 至 ${job.launcher ?? '远程'} 会话`;
  }
  appendJobEvent(jobId, 'stop', detail);
  appendJobEvent(jobId, 'stop', '演示模式：任务已停止');
  transitionJob(jobId, 'canceled', {
    patch: { finishedAt: Date.now(), error: null },
    message: '用户停止任务（演示）',
  });
  demoNotifyJobTerminal(jobId);
  return getJobDto(jobId);
}