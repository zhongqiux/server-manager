import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JOB_LAUNCHER_PREFERENCES,
  JOB_SESSION_MODES,
  JOB_STATUSES,
  isJobTerminal,
  type JobInput,
} from '@sm/shared';
import { z } from 'zod';
import type { SmClient } from '../client.ts';
import {
  errorResult,
  jobWithRedaction,
  jsonResult,
  summarizeJob,
  targetSecrets,
  textResult,
} from '../format.ts';

const jobId = z.string().uuid().describe('任务 ID');
const targetId = z.string().uuid().describe('目标 Target ID，可从 list_targets 获取');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerJobTools(
  server: McpServer,
  client: SmClient,
  allowWrites: boolean,
): void {
  server.registerTool(
    'list_jobs',
    {
      title: '列出任务',
      description:
        '查看任务历史与当前状态，可按 Target、项目、服务器、状态过滤。返回摘要，不含任务脚本。',
      inputSchema: {
        targetId: z.string().uuid().optional().describe('可选：只查看该 Target 的任务'),
        projectId: z.string().uuid().optional().describe('可选：只查看该项目的任务'),
        serverId: z.string().uuid().optional().describe('可选：只查看该服务器上的任务'),
        active: z.boolean().optional().describe('true 只看进行中，false 只看已结束'),
        status: z.enum(JOB_STATUSES).optional().describe('精确状态过滤'),
        limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 20'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ targetId, projectId, serverId, active, status, limit }) => {
      try {
        const jobs = await client.listJobs({
          targetId,
          projectId,
          serverId,
          active,
          status,
          limit: limit ?? 20,
        });
        return jsonResult({ jobs: jobs.map(summarizeJob) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_job',
    {
      title: '查看任务详情',
      description:
        '查看任务状态、会话/窗口、退出码、错误、状态时间线，以及脱敏后的渲染命令。默认不返回完整脚本。',
      inputSchema: {
        jobId,
        includeScript: z
          .boolean()
          .optional()
          .default(false)
          .describe('是否返回完整任务脚本（环境变量值已脱敏）'),
        includeEvents: z
          .boolean()
          .optional()
          .default(true)
          .describe('是否返回状态时间线'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ jobId: id, includeScript, includeEvents }) => {
      try {
        const job = await client.getJob(id);
        const target = await client.getTarget(job.targetId).catch(() => null);
        const secrets = target ? targetSecrets(target) : [];
        const result = jobWithRedaction(job, secrets, includeScript);
        if (!includeEvents) delete result.events;
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'read_job_logs',
    {
      title: '读取任务日志',
      description:
        '读取任务日志的尾部或指定区间（base64 在内部解码为文本）。用 end=返回的 start 可继续向前翻页。日志可能包含敏感信息，请勿外传。',
      inputSchema: {
        jobId,
        bytes: z
          .number()
          .int()
          .min(1024)
          .max(262144)
          .optional()
          .describe('读取字节数，默认 131072，最大 262144'),
        end: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('可选：读取到该字节位置为止（用于向前翻页）；省略则读取最新尾部'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId: id, bytes, end }) => {
      try {
        const chunk = await client.readJobLogs(id, { bytes, end });
        const text = Buffer.from(chunk.data, 'base64').toString('utf8');
        const sizeText = chunk.size === null ? '未知' : String(chunk.size);
        const header = [
          `任务 ${id} 日志（字节 ${chunk.start}–${chunk.end} / ${sizeText}）`,
          '提示：日志可能包含敏感信息；可用 end=' + chunk.start + ' 继续向前读取。',
          '',
        ].join('\n');
        return textResult(`${header}\n${text || '（日志为空）'}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'wait_job',
    {
      title: '等待任务结束',
      description:
        '轮询等待任务进入终态（exited/failed/canceled/lost/...）。最多等待 45 秒；超时不会停止任务，可稍后再次查询。',
      inputSchema: {
        jobId,
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(45)
          .optional()
          .describe('最长等待秒数，默认 20'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId: id, timeoutSeconds }) => {
      try {
        let job = await client.getJob(id);
        if (!isJobTerminal(job.status)) {
          const deadline = Date.now() + (timeoutSeconds ?? 20) * 1000;
          while (Date.now() < deadline) {
            await sleep(Math.min(1500, Math.max(200, deadline - Date.now())));
            job = await client.getJob(id);
            if (isJobTerminal(job.status)) break;
          }
        }
        const timedOut = !isJobTerminal(job.status);
        return jsonResult({
          timedOut,
          job: summarizeJob(job),
          ...(timedOut ? { hint: '任务仍在运行，可稍后再次调用 get_job 或 wait_job。' } : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  if (!allowWrites) return;

  server.registerTool(
    'start_job',
    {
      title: '创建任务',
      description:
        '在 Target 上创建并启动任务，返回后立即得到任务 ID。默认 sessionMode=new（新建独立 tmux/screen/nohup 会话），不会触碰用户已有会话。使用已有会话时：先调用 list_remote_sessions；new_window 需指定 launcher（tmux/screen）与 sessionName；existing_window 还需 windowId，并确保该窗口空闲。syncFirst=true 会先同步再运行，目前仅支持 SFTP 目标。',
      inputSchema: {
        targetId,
        title: z.string().max(200).optional().describe('任务标题，省略时自动生成'),
        command: z
          .string()
          .max(20_000)
          .optional()
          .describe('可选：覆盖 Target 的运行命令（仍会渲染模板变量）'),
        syncFirst: z
          .boolean()
          .optional()
          .describe('是否先执行同步再启动，仅 SFTP 模式支持'),
        launcher: z
          .enum(JOB_LAUNCHER_PREFERENCES)
          .optional()
          .describe('auto/tmux/screen/nohup；使用已有会话时必须显式指定 tmux 或 screen'),
        sessionMode: z
          .enum(JOB_SESSION_MODES)
          .optional()
          .describe('new（默认）/new_window/existing_window'),
        sessionName: z.string().max(256).optional().describe('已有 tmux/screen 会话名'),
        windowId: z
          .string()
          .max(64)
          .optional()
          .describe('已有窗口标识：tmux 形如 @1，screen 为窗口序号'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const input: JobInput = {
          targetId: args.targetId,
          title: args.title,
          command: args.command,
          syncFirst: args.syncFirst,
          launcher: args.launcher,
          sessionMode: args.sessionMode,
          sessionName: args.sessionName,
          windowId: args.windowId,
        };
        const job = await client.startJob(input);
        return jsonResult({
          job: summarizeJob(job),
          note: '任务已创建。用 wait_job 等待结束，用 read_job_logs 查看日志，用 stop_job 停止。',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'stop_job',
    {
      title: '停止任务',
      description:
        '优雅停止任务：发送 Ctrl-C 并终止本工具记录的进程组；已有会话或已有窗口不会被关闭。force=true 会跳过部分优雅步骤。',
      inputSchema: {
        jobId,
        force: z.boolean().optional().describe('是否强制停止，默认 false'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId: id, force }) => {
      try {
        const job = await client.stopJob(id, Boolean(force));
        return jsonResult({
          job: summarizeJob(job),
          note: '停止流程已启动，可用 wait_job 或 get_job 查看最终状态；用户已有会话和窗口不会被关闭。',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}