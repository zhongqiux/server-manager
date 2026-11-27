import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SmClient } from '../client.ts';
import { errorResult, jsonResult } from '../format.ts';

export function registerOverviewTools(server: McpServer, client: SmClient): void {
  server.registerTool(
    'get_overview',
    {
      title: '调度台总览',
      description:
        '一次返回应用健康状态、在线服务器数、GPU 总量/空闲数、运行中任务和最近同步记录。agent 进入调度台后应先调用此工具了解全局。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const [health, dashboard] = await Promise.all([
          client.health(),
          client.getOverview(),
        ]);
        return jsonResult({ app: health, ...dashboard });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerResource(
    'dashboard',
    'sm://dashboard',
    {
      title: 'Server Manager 总览',
      description: '当前 GPU、服务器、运行中任务与最近同步的 JSON 快照。',
      mimeType: 'application/json',
    },
    async (uri) => {
      const [health, dashboard] = await Promise.all([
        client.health(),
        client.getOverview(),
      ]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ app: health, ...dashboard }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'servers',
    'sm://servers',
    {
      title: '服务器列表',
      description: '所有已配置服务器的连接状态、硬件快照与 GPU 状态（不含任何凭据）。',
      mimeType: 'application/json',
    },
    async (uri) => {
      const servers = await client.listServers();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ servers }, null, 2),
          },
        ],
      };
    },
  );
}