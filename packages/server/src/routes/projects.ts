import { Router } from 'express';
import { z } from 'zod';
import {
  createProject,
  deleteProject,
  explainProjectIgnore,
  getProjectDto,
  listProjects,
  scanProject,
  updateProject,
} from '../services/projects.ts';
import { parseBody } from './validate.ts';

export const projectsRouter = Router();

const projectInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 个字符'),
  localRoot: z.string().trim().min(1, '请填写本地目录').max(1024),
  ignoreExtra: z.array(z.string().max(256)).max(200).optional(),
  execBitPolicy: z.enum(['auto', 'all755']).optional(),
});

const patchSchema = projectInputSchema.partial();

const explainSchema = z.object({
  path: z.string().trim().min(1, '请填写文件路径').max(1024),
  targetId: z.string().uuid().optional(),
});

projectsRouter.get('/', (_req, res) => {
  res.json({ items: listProjects() });
});

projectsRouter.post('/', (req, res) => {
  const input = parseBody(projectInputSchema, req.body);
  res.status(201).json(createProject(input));
});

projectsRouter.get('/:id', (req, res) => {
  res.json(getProjectDto(req.params.id));
});

projectsRouter.patch('/:id', (req, res) => {
  const patch = parseBody(patchSchema, req.body);
  res.json(updateProject(req.params.id, patch));
});

projectsRouter.delete('/:id', (req, res) => {
  res.json(deleteProject(req.params.id));
});

projectsRouter.post('/:id/scan', async (req, res) => {
  res.json(await scanProject(req.params.id));
});

projectsRouter.post('/:id/ignore/explain', (req, res) => {
  const body = parseBody(explainSchema, req.body);
  res.json(explainProjectIgnore(req.params.id, body.path, body.targetId));
});