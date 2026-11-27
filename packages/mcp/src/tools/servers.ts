import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SmClient } from '../client.ts';
import { errorResult, jsonResult } from '../format.ts';

const serverId = z.string().uuid().describe('服务器 ID，可从 list_servers 或 get_overview 获取');

export function registerServerTools(server: McpServer, client: SmClient): void {
  server.registerTool(
    'list_servers',
    {
      title: '列出服务器',
      description:
        '列出所有服务器及其在线状态、硬件摘要和 GPU 实时快照。返回结果不含密码或私钥。选择运行机器时先看这里。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return jsonResult({ servers: await client.listServers() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_server',
    {
      title: '查看服务器详情',
      description:
        '查看单台服务器的连接状态、能力探测结果、硬件快照和当前 GPU 指标（型号、利用率、显存、进程）。',
      inputSchema: { serverId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ serverId: id }) => {
      try {
        return jsonResult(await client.getServer(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'test_server',
    {
      title: '测试服务器连接',
      description:
        '对已保存的服务器执行 TCP/SSH 认证/远程命令三步连接测试，并刷新能力探测。可能耗时数十秒。',
      inputSchema: { serverId },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serverId: id }) => {
      try {
        return jsonResult(await client.testServer(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'probe_server',
    {
      title: '刷新服务器硬件快照',
      description:
        '重新采集服务器的 OS、CPU、内存、磁盘、GPU 列表、驱动/CUDA 版本与 conda 环境。可能耗时数十秒。',
      inputSchema: { serverId },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serverId: id }) => {
      try {
        return jsonResult(await client.probeServer(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_remote_sessions',
    {
      title: '列出远程 tmux/screen 会话',
      description:
        '读取目标服务器上正在运行的 tmux 会话/窗口和 screen 会话/窗口，包括窗口当前前台命令。要在用户已有会话中新开窗口或注入命令前，先调用此工具。',
      inputSchema: { serverId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ serverId: id }) => {
      try {
        return jsonResult(await client.listRemoteSessions(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}