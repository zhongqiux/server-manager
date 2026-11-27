import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SmClient } from '../client.ts';
import { errorResult, jsonResult } from '../format.ts';

const projectId = z.string().uuid().describe('项目 ID，可从 list_projects 获取');

export function registerProjectTools(server: McpServer, client: SmClient): void {
  server.registerTool(
    'list_projects',
    {
      title: '列出项目',
      description: '列出本地项目及其根目录、Target 数量和忽略规则数量。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return jsonResult({ projects: await client.listProjects() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_project',
    {
      title: '查看项目',
      description: '查看单个项目的本地根目录、额外忽略规则与可执行位策略。',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) => {
      try {
        return jsonResult(await client.getProject(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'scan_project',
    {
      title: '扫描项目文件',
      description:
        '按忽略规则扫描本地项目，返回文件数、目录数、总字节数、被忽略条目以及顶层条目。用于同步前确认目录与忽略规则是否合理。',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id }) => {
      try {
        return jsonResult(await client.scanProject(id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'explain_ignore',
    {
      title: '解释忽略规则',
      description:
        '解释某个相对路径为什么被同步忽略（命中的规则与来源：default/project/target/hard）。可传 targetId 以计入该 Target 的额外规则。',
      inputSchema: {
        projectId,
        path: z.string().min(1).max(1024).describe('相对项目根目录的文件路径，使用 / 分隔'),
        targetId: z.string().uuid().optional().describe('可选 Target ID，用于计入 Target 级忽略规则'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId: id, path, targetId }) => {
      try {
        return jsonResult(await client.explainIgnore(id, path, targetId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}