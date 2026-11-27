import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JobDTO, SyncRunDTO, TargetDTO, TargetPreview } from '@sm/shared';
import { SmApiError, SmUnavailableError } from './client.ts';

const MASK = '******';
const MAX_RESULT_CHARS = 60_000;

export function jsonResult(value: unknown, maxChars = MAX_RESULT_CHARS): CallToolResult {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  if (text.length <= maxChars) {
    return { content: [{ type: 'text', text }] };
  }
  return {
    content: [
      {
        type: 'text',
        text: `${text.slice(0, maxChars)}\n\n…（输出已截断：原始 ${text.length} 字符，仅展示前 ${maxChars} 字符）`,
      },
    ],
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof SmApiError) {
    const label = [err.code, `HTTP ${err.status}`].filter(Boolean).join(' · ');
    message = `Server Manager 接口错误（${label}）：${err.message}`;
    if (err.code === 'MIRROR_DELETE_CONFIRM_REQUIRED') {
      message += '\n请先执行 dry-run 检查删除清单；真实同步时传入 confirmTargetName（目标 label，未设置时为服务器名）。';
    }
    if (err.code === 'LOG_NOT_AVAILABLE') {
      message += '\n任务尚未生成日志，或日志路径尚未写入；可稍后重试。';
    }
  } else if (err instanceof SmUnavailableError) {
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function maskEnvVars(vars: Record<string, string> | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(vars ?? {})) result[key] = MASK;
  return result;
}

export function redactUrl(value: string): string {
  return value
    .replace(/(\/\/)[^/@\s]+@/g, `$1${MASK}@`)
    .replace(
      /([?&](?:token|access_token|private_token|password|secret|key)=)[^&\s]+/gi,
      `$1${MASK}`,
    );
}

export function redactText(text: string | null | undefined, secrets: string[]): string | null {
  if (text === null || text === undefined) return null;
  let out = redactUrl(text);
  const values = [...new Set(secrets)]
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of values) {
    out = out.split(secret).join(MASK);
  }
  return out;
}

export function targetSecrets(target: TargetDTO): string[] {
  const secrets: string[] = Object.values(target.envVars ?? {});
  const remoteUrl = target.syncConfig?.remoteUrl;
  if (remoteUrl) {
    try {
      const url = new URL(remoteUrl);
      if (url.username) secrets.push(url.username);
      if (url.password) secrets.push(url.password);
      for (const key of ['token', 'access_token', 'private_token', 'password', 'secret']) {
        const value = url.searchParams.get(key);
        if (value) secrets.push(value);
      }
    } catch {
      // 非标准 URL 时只依赖 env 值脱敏
    }
  }
  return [...new Set(secrets)];
}

export function sanitizeTarget(target: TargetDTO): Record<string, unknown> {
  const syncConfig: Record<string, unknown> = { ...target.syncConfig };
  const remoteUrl = syncConfig.remoteUrl;
  if (typeof remoteUrl === 'string' && remoteUrl) {
    syncConfig.remoteUrl = redactUrl(remoteUrl);
  }
  return {
    ...target,
    envVars: maskEnvVars(target.envVars),
    envVarsMasked: true,
    syncConfig,
  };
}

export function summarizeJob(job: JobDTO): Record<string, unknown> {
  return {
    id: job.id,
    targetId: job.targetId,
    projectId: job.projectId,
    serverId: job.serverId,
    title: job.title,
    status: job.status,
    launcher: job.launcher,
    sessionMode: job.sessionMode,
    sessionName: job.sessionName,
    windowId: job.windowId,
    windowName: job.windowName,
    exitCode: job.exitCode,
    error: job.error,
    remotePid: job.remotePid,
    remotePgid: job.remotePgid,
    logBytes: job.logBytes,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastSeenAt: job.lastSeenAt,
    projectName: job.projectName,
    serverName: job.serverName,
    targetLabel: job.targetLabel,
  };
}

export function summarizeSyncRun(run: SyncRunDTO): Record<string, unknown> {
  return {
    id: run.id,
    projectId: run.projectId,
    targetId: run.targetId,
    mode: run.mode,
    direction: run.direction,
    dryRun: run.dryRun,
    status: run.status,
    counts: run.counts,
    bytes: run.bytes,
    git: run.git,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export function jobWithRedaction(
  job: JobDTO,
  secrets: string[],
  includeScript: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...job,
    renderedCommand: redactText(job.renderedCommand, secrets),
  };
  if (includeScript) {
    result.scriptContent = redactText(job.scriptContent, secrets);
  } else {
    delete result.scriptContent;
  }
  return result;
}

export function previewWithRedaction(
  preview: TargetPreview,
  secrets: string[],
): Record<string, unknown> {
  return {
    ...preview,
    renderedCommand: redactText(preview.renderedCommand, secrets),
    scriptContent: redactText(preview.scriptContent, secrets),
  };
}