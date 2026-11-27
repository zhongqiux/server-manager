import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBase, SmApiError, SmClient } from './client.ts';

let server: ReturnType<typeof createServer>;
let port = 0;
const syncBodies: Record<string, unknown>[] = [];
let lastJobsQuery = '';

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          version: 'test',
          node: 'v22',
          uptime: 1,
          demo: true,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/servers') {
        sendJson(res, 200, { items: [{ id: 'server-1', name: 'A100' }] });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/servers/missing') {
        sendJson(res, 404, {
          error: { code: 'SERVER_NOT_FOUND', message: '服务器不存在' },
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        lastJobsQuery = url.search;
        sendJson(res, 200, { items: [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sync/runs') {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        syncBodies.push(body);
        sendJson(res, 202, {
          id: 'run-1',
          status: 'pending',
          dryRun: body.dryRun,
          counts: null,
          error: null,
        });
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('MCP HTTP 客户端', () => {
  it('通过健康检查发现服务地址', async () => {
    await expect(discoverBase([port], 1000)).resolves.toBe(`http://127.0.0.1:${port}`);
  });

  it('读取服务器列表并映射接口错误', async () => {
    const client = new SmClient({ baseUrl: `http://127.0.0.1:${port}` });
    const servers = await client.listServers();
    expect(servers[0]).toMatchObject({ id: 'server-1', name: 'A100' });

    await expect(client.getServer('missing')).rejects.toMatchObject({
      name: 'SmApiError',
      status: 404,
      code: 'SERVER_NOT_FOUND',
      message: '服务器不存在',
    });
    await expect(client.getServer('missing')).rejects.toBeInstanceOf(SmApiError);
  });

  it('同步默认 dry-run，显式 false 才发起真实同步', async () => {
    const client = new SmClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.startSync({ targetId: '11111111-1111-4111-8111-111111111111' });
    await client.startSync({
      targetId: '11111111-1111-4111-8111-111111111111',
      dryRun: false,
    });
    expect(syncBodies).toHaveLength(2);
    expect(syncBodies[0]).toMatchObject({ dryRun: true });
    expect(syncBodies[1]).toMatchObject({ dryRun: false });
  });

  it('布尔过滤条件按 API 查询参数传递', async () => {
    const client = new SmClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.listJobs({ active: true, limit: 5 });
    expect(lastJobsQuery).toContain('active=true');
    expect(lastJobsQuery).toContain('limit=5');
  });
});