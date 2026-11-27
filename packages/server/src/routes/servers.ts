import { Router } from 'express';
import { z } from 'zod';
import { AUTH_TYPES, HOST_KEY_POLICIES } from '@sm/shared';
import {
  createServer,
  deleteServer,
  getServerDto,
  listServers,
  probeServerHardware,
  testServerById,
  testServerDraft,
  updateServer,
} from '../services/servers.ts';
import { gpuHub } from '../realtime/gpuhub.ts';
import { isDemoId } from '../demo/ids.ts';
import { demoRemoteSessions } from '../demo/fixtures.ts';
import { listRemoteSessions } from '../jobs/remote-sessions.ts';
import { parseBody } from './validate.ts';

export const serversRouter = Router();

const serverInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 个字符'),
  host: z.string().trim().min(1, '主机不能为空').max(255),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1, '用户名不能为空').max(128),
  authType: z.enum(AUTH_TYPES),
  password: z.string().max(4096).nullable().optional(),
  privateKey: z.string().max(65536).nullable().optional(),
  passphrase: z.string().max(2048).nullable().optional(),
  hostKeyPolicy: z.enum(HOST_KEY_POLICIES).optional(),
  color: z.string().max(32).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  notes: z.string().max(4000).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const patchSchema = serverInputSchema.partial();

const draftOverrideSchema = z.object({
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(128).optional(),
  authType: z.enum(AUTH_TYPES).optional(),
  password: z.string().max(4096).nullable().optional(),
  privateKey: z.string().max(65536).nullable().optional(),
  passphrase: z.string().max(2048).nullable().optional(),
  hostKeyPolicy: z.enum(HOST_KEY_POLICIES).optional(),
});

const draftTestSchema = serverInputSchema.extend({
  name: z.string().optional().default('draft'),
});

serversRouter.get('/', (_req, res) => {
  const items = listServers().map((server) => ({
    ...server,
    gpu: gpuHub.getSnapshot(server.id) ?? undefined,
  }));
  res.json({ items });
});

serversRouter.post('/', (req, res) => {
  const input = parseBody(serverInputSchema, req.body);
  res.status(201).json(createServer(input));
});

serversRouter.post('/test', async (req, res) => {
  const input = parseBody(draftTestSchema, req.body);
  res.json(await testServerDraft(input));
});

serversRouter.get('/:id', (req, res) => {
  const server = getServerDto(req.params.id);
  res.json({ ...server, gpu: gpuHub.getSnapshot(server.id) ?? undefined });
});

serversRouter.get('/:id/gpu', (req, res) => {
  const server = getServerDto(req.params.id);
  res.json({ snapshot: gpuHub.getSnapshot(server.id) });
});

serversRouter.get('/:id/sessions', async (req, res) => {
  const server = getServerDto(req.params.id);
  if (isDemoId(server.id)) {
    res.json(demoRemoteSessions(server.id));
    return;
  }
  res.json(await listRemoteSessions(server.id));
});

serversRouter.patch('/:id', (req, res) => {
  const patch = parseBody(patchSchema, req.body);
  res.json(updateServer(req.params.id, patch));
});

serversRouter.delete('/:id', (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  res.json(deleteServer(req.params.id, force));
});

serversRouter.post('/:id/test', async (req, res) => {
  const body = parseBody(z.object({ useDraft: draftOverrideSchema.optional() }), req.body ?? {});
  res.json(await testServerById(req.params.id, body.useDraft));
});

serversRouter.post('/:id/probe', async (req, res) => {
  res.json(await probeServerHardware(req.params.id));
});