#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SmClient } from './client.ts';
import { loadConfig } from './config.ts';
import { registerPrompts } from './prompts.ts';
import { registerAllTools } from './tools/index.ts';

const INSTRUCTIONS = [
  '这是 Server Manager（本地多 GPU 服务器调度台）的 MCP 服务。',
  '可用工具查看服务器/GPU/tmux/screen 会话、扫描项目、预览 Target、发起同步、创建任务、读取日志。',
  '所有 ID 必须从工具结果获取，不要猜测。',
  '同步默认 dry-run，真实同步需要显式 dryRun=false；镜像删除还需要 confirmTargetName。',
  '创建任务默认 sessionMode=new（新建独立会话），不要触碰用户已有会话，除非用户明确要求。',
  '本服务不提供密码/私钥读写，服务器凭据请在 Web 界面维护。',
].join('\n');

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SmClient({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
  const server = new McpServer(
    { name: 'server-manager', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  registerAllTools(server, client, { readOnly: config.readOnly });
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const base = config.baseUrl ?? '自动发现 127.0.0.1:8787–8806';
  console.error(
    `[server-manager-mcp] ready · base=${base} · readOnly=${config.readOnly ? 'yes' : 'no'}`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[server-manager-mcp] 启动失败：${message}`);
  process.exit(1);
});