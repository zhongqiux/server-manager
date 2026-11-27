import { Router } from 'express';
import { z } from 'zod';
import { SYNC_MODES } from '@sm/shared';
import {
  createTarget,
  deleteTarget,
  getTargetDto,
  listTargets,
  previewTargetById,
  previewTargetDraft,
  updateTarget,
} from '../services/targets.ts';
import { parseBody } from './validate.ts';
import { detectGitTarget } from '../sync/git-engine.ts';

export const targetsRouter = Router();

const syncConfigSchema = z.object({
  mirrorDelete: z.boolean().optional(),
  extraIgnores: z.array(z.string().max(256)).max(200).optional(),
  sizeOnly: z.boolean().optional(),
  preserveMode: z.boolean().optional(),
  protectGlobs: z.array(z.string().max(256)).max(100).optional(),
  remoteUrl: z.string().max(1000).optional(),
  branch: z.string().max(200).optional(),
  remoteName: z.string().max(100).optional(),
  sourceKind: z.enum(['local', 'target']).optional(),
  sourceTargetId: z.string().uuid().nullable().optional(),
  autoCommitOnSource: z.boolean().optional(),
  cloneIfMissing: z.boolean().optional(),
  commitMessageTemplate: z.string().max(500).optional(),
});

const targetInputSchema = z.object({
  projectId: z.string().uuid(),
  serverId: z.string().uuid(),
  label: z.string().trim().max(64).nullable().optional(),
  remoteCodeDir: z.string().trim().min(1, '请填写远程代码目录').max(1024),
  dataDir: z.string().trim().max(1024).nullable().optional(),
  condaEnv: z.string().trim().max(256).nullable().optional(),
  envVars: z.record(z.string().max(128), z.string().max(4096)).optional(),
  preCommand: z.string().max(8000).nullable().optional(),
  runCommand: z.string().trim().min(1, '运行命令不能为空').max(8000),
  gpuDevices: z.string().trim().max(256).nullable().optional(),
  syncMode: z.enum(SYNC_MODES).optional(),
  syncConfig: syncConfigSchema.optional(),
  keepSession: z.boolean().optional(),
});

const patchSchema = targetInputSchema.omit({ projectId: true, serverId: true }).partial();

const listQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  serverId: z.string().uuid().optional(),
});

targetsRouter.get('/', (req, res) => {
  const query = parseBody(listQuerySchema, req.query);
  res.json({ items: listTargets(query) });
});

targetsRouter.post('/', (req, res) => {
  const input = parseBody(targetInputSchema, req.body);
  res.status(201).json(createTarget(input));
});

targetsRouter.post('/preview', (req, res) => {
  const input = parseBody(targetInputSchema, req.body);
  res.json(previewTargetDraft(input));
});

targetsRouter.get('/:id', (req, res) => {
  res.json(getTargetDto(req.params.id));
});

targetsRouter.patch('/:id', (req, res) => {
  const patch = parseBody(patchSchema, req.body);
  res.json(updateTarget(req.params.id, patch));
});

targetsRouter.delete('/:id', (req, res) => {
  res.json(deleteTarget(req.params.id));
});

targetsRouter.post('/:id/preview', (req, res) => {
  res.json(previewTargetById(req.params.id));
});

targetsRouter.post('/:id/git/detect', async (req, res) => {
  res.json(await detectGitTarget(req.params.id));
});