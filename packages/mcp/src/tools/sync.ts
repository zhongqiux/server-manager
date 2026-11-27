import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncRunStatus } from '@sm/shared';
import { z } from 'zod';
import type { SmClient } from '../client.ts';
import { errorResult, jsonResult, summarizeSyncRun } from '../format.ts';

const TERMINAL_SYNC_STATUSES = new Set<SyncRunStatus>(['done', 'failed', 'canceled']);
const runId = z.string().uuid().describe('同步运行 ID');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerSyncTools(
  server: McpServer,
  client: SmClient,
  allowWrites: boolean,
): void {
  server.registerTool(
    'list_sync_runs',
    {
      title: '列出同步记录',
      description: '查看历史同步运行（dry-run 与真实同步），返回状态、计数、方向与错误信息。',
      inputSchema: {
        targetId: z.string().uuid().optional().describe('可选：只查看该 Target 的同步'),
        projectId: z.string().uuid().optional().describe('可选：只查看该项目的同步'),
        limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 20'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ targetId, projectId, limit }) => {
      try {
        const runs = await client.listSyncRuns({ targetId, projectId, limit: limit ?? 20 });
        return jsonResult({ runs: runs.map(summarizeSyncRun) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_sync_run',
    {
      title: '查看同步详情',
      description:
        '查看单次同步的完整状态、计数、字节统计、截断后的文件计划（add/update/delete）和错误信息。',
      inputSchema: { runId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId: id }) => {
      try {
        return jsonResult(await client.getSyncRun(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'wait_sync',
    {
      title: '等待同步结束',
      description:
        '轮询等待同步进入 done/failed/canceled。最多等待 45 秒；超时不会取消同步，可稍后再调用 get_sync_run。',
      inputSchema: {
        runId,
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(45)
          .optional()
          .describe('最长等待秒数，默认 20'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId: id, timeoutSeconds }) => {
      try {
        let run = await client.getSyncRun(id);
        if (!TERMINAL_SYNC_STATUSES.has(run.status)) {
          const deadline = Date.now() + (timeoutSeconds ?? 20) * 1000;
          while (Date.now() < deadline) {
            await sleep(Math.min(1500, Math.max(200, deadline - Date.now())));
            run = await client.getSyncRun(id);
            if (TERMINAL_SYNC_STATUSES.has(run.status)) break;
          }
        }
        const timedOut = !TERMINAL_SYNC_STATUSES.has(run.status);
        return jsonResult({
          timedOut,
          run: summarizeSyncRun(run),
          ...(timedOut ? { hint: '同步仍在进行，可稍后再次调用 get_sync_run 或 wait_sync。' } : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  if (!allowWrites) return;

  server.registerTool(
    'start_sync',
    {
      title: '发起代码同步',
      description:
        '在 Target 上发起同步。默认 dryRun=true，只返回同步计划、不写远程文件；真正执行必须显式传 dryRun=false。若 Target 开启了镜像删除，真实同步还必须传 confirmTargetName（目标 label，未设置时为服务器名）。传 sourceTargetId 可执行 A→B 中转（SFTP 模式）。',
      inputSchema: {
        targetId: z.string().uuid().describe('目标 Target ID'),
        dryRun: z.boolean().optional().default(true).describe('默认 true；真实同步请显式传 false'),
        sourceTargetId: z
          .string()
          .uuid()
          .optional()
          .describe('可选：A→B 中转的源 Target ID，必须与 targetId 不同'),
        confirmTargetName: z
          .string()
          .max(128)
          .optional()
          .describe('镜像删除开启时，真实同步必须传目标 label 或服务器名以确认'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ targetId, dryRun, sourceTargetId, confirmTargetName }) => {
      try {
        const run = await client.startSync({
          targetId,
          dryRun,
          sourceTargetId,
          confirmTargetName,
        });
        return jsonResult({
          run: summarizeSyncRun(run),
          note: run.dryRun
            ? '当前为 dry-run，未写入远程文件。确认计划后可用 dryRun=false 发起真实同步。'
            : '真实同步已发起，可用 wait_sync 等待完成，或用 get_sync_run 查看进度。',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cancel_sync',
    {
      title: '取消同步',
      description: '取消正在运行的同步。已结束的同步无法取消。',
      inputSchema: { runId },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId: id }) => {
      try {
        const run = await client.cancelSyncRun(id);
        return jsonResult({
          run: summarizeSyncRun(run),
          note: '取消请求已发送，可用 get_sync_run 查看最终状态。',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}