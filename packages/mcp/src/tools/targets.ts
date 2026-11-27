import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SmClient } from '../client.ts';
import {
  errorResult,
  jsonResult,
  previewWithRedaction,
  sanitizeTarget,
  targetSecrets,
} from '../format.ts';

const targetId = z.string().uuid().describe('Target ID，可从 list_targets 获取');

export function registerTargetTools(server: McpServer, client: SmClient): void {
  server.registerTool(
    'list_targets',
    {
      title: '列出 Target',
      description:
        '列出项目与服务器的绑定（Target）及其远程代码目录、conda 环境、运行命令模板、同步模式。环境变量值会脱敏。可按项目或服务器过滤。',
      inputSchema: {
        projectId: z.string().uuid().optional().describe('可选：只列出该项目的 Target'),
        serverId: z.string().uuid().optional().describe('可选：只列出该服务器上的 Target'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, serverId }) => {
      try {
        const items = await client.listTargets({ projectId, serverId });
        return jsonResult({ targets: items.map(sanitizeTarget) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_target',
    {
      title: '查看 Target',
      description:
        '查看单个 Target 的完整配置（环境变量值已脱敏），包括渲染前运行命令模板、GPU 设备与同步配置。',
      inputSchema: { targetId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ targetId: id }) => {
      try {
        const target = await client.getTarget(id);
        return jsonResult(sanitizeTarget(target));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'preview_target',
    {
      title: '预览 Target 启动脚本',
      description:
        '渲染该 Target 的最终运行命令与完整任务脚本（含 conda 激活、环境变量、前置命令），并返回模板告警。用于运行前确认；环境变量值会脱敏。',
      inputSchema: { targetId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ targetId: id }) => {
      try {
        const [target, preview] = await Promise.all([
          client.getTarget(id),
          client.previewTarget(id),
        ]);
        return jsonResult({
          target: {
            id: target.id,
            projectId: target.projectId,
            serverId: target.serverId,
            label: target.label,
            syncMode: target.syncMode,
            envVarsMasked: true,
          },
          ...previewWithRedaction(preview, targetSecrets(target)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}