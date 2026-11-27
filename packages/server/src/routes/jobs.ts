import { Router } from 'express';
import { z } from 'zod';
import {
  JOB_LAUNCHER_PREFERENCES,
  JOB_SESSION_MODES,
  JOB_STATUSES,
  isJobTerminal,
  shq,
  type JobStatus,
} from '@sm/shared';
import { isDemoId } from '../demo/ids.ts';
import {
  demoLogDownloadText,
  demoReadChunk,
  streamDemoJobLog,
} from '../demo/logs.ts';
import { createDemoJob, stopDemoJob } from '../demo/actions.ts';
import { ApiError, notFound } from '../errors.ts';
import { logHub } from '../jobs/loghub.ts';
import { readLogRange, statLogSize, stripAnsi } from '../jobs/logio.ts';
import { execOnJobServer } from '../jobs/probe.ts';
import { createJob } from '../jobs/runner.ts';
import { stopJob } from '../jobs/stop.ts';
import { initSse, sendSse, startHeartbeat } from '../realtime/sse.ts';
import { getJobDto, getJobRow, listJobs } from '../services/jobs.ts';
import { getServerConnectConfig } from '../services/servers.ts';
import { getTargetRow } from '../services/targets.ts';
import { parseBody } from './validate.ts';

export const jobsRouter = Router();

const createSchema = z.object({
  targetId: z.string().uuid(),
  command: z.string().max(200_000).optional(),
  syncFirst: z.boolean().optional(),
  title: z.string().max(200).optional(),
  launcher: z.enum(JOB_LAUNCHER_PREFERENCES).optional(),
  sessionMode: z.enum(JOB_SESSION_MODES).optional(),
  sessionName: z.string().max(256).optional(),
  windowId: z.string().max(64).optional(),
  windowName: z.string().max(256).optional(),
});

const listQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  serverId: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const stopSchema = z.object({ force: z.boolean().optional() });

const chunkQuerySchema = z.object({
  end: z.coerce.number().int().min(0).optional(),
  bytes: z.coerce.number().int().min(1024).max(1024 * 1024).optional(),
});

function parseOffset(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

jobsRouter.post('/', (req, res) => {
  const input = parseBody(createSchema, req.body);
  const target = getTargetRow(input.targetId);
  if (target && isDemoId(target.server_id)) {
    res.status(202).json(createDemoJob(input));
    return;
  }
  res.status(202).json(createJob(input));
});

jobsRouter.get('/', (req, res) => {
  const query = parseBody(listQuerySchema, req.query);
  res.json({
    items: listJobs({
      targetId: query.targetId,
      projectId: query.projectId,
      serverId: query.serverId,
      status: query.status as JobStatus | undefined,
      active: query.active === undefined ? undefined : query.active === 'true',
      limit: query.limit,
    }),
  });
});

jobsRouter.get('/:id', (req, res) => {
  res.json(getJobDto(req.params.id, { events: true }));
});

jobsRouter.post('/:id/stop', (req, res) => {
  const body = parseBody(stopSchema, req.body ?? {});
  const job = getJobRow(req.params.id);
  if (!job) throw notFound('任务');
  if (isDemoId(job.server_id)) {
    res.status(202).json(stopDemoJob(job.id, Boolean(body.force)));
    return;
  }
  res.status(202).json(stopJob(req.params.id, Boolean(body.force)));
});

jobsRouter.get('/:id/logs/stream', (req, res) => {
  let job = getJobRow(req.params.id);
  if (!job) throw notFound('任务');
  const jobId = job.id;
  const lastOffset = parseOffset(req.headers['last-event-id']) || parseOffset(req.query.after);
  if (isDemoId(job.server_id)) {
    streamDemoJobLog(job, res, lastOffset);
    return;
  }

  initSse(res);
  const stopHeartbeat = startHeartbeat(res);
  let closed = false;
  let detach: (() => void) | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    detach?.();
  };
  req.on('close', cleanup);

  void (async () => {
    if (!job.log_path && !isJobTerminal(job.status as JobStatus)) {
      sendSse(res, { type: 'waiting', jobId, message: '等待任务启动并生成日志…' });
      while (!closed && !job.log_path && !isJobTerminal(job.status as JobStatus)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (closed) return;
        const fresh = getJobRow(jobId);
        if (!fresh) {
          sendSse(res, { type: 'end', jobId, reason: 'no_log' });
          cleanup();
          res.end();
          return;
        }
        job = fresh;
      }
    }
    if (closed) return;
    if (!job.log_path) {
      sendSse(res, { type: 'end', jobId, reason: 'no_log' });
      cleanup();
      res.end();
      return;
    }
    detach = logHub.attach(job, res, lastOffset);
  })().catch((err: unknown) => {
    if (closed) return;
    sendSse(res, {
      type: 'end',
      jobId,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    cleanup();
    try {
      res.end();
    } catch {
      // 忽略
    }
  });
});

async function readChunk(jobId: string, endInput?: number, bytes = 131072) {
  const job = getJobRow(jobId);
  if (!job) throw notFound('任务');
  if (!job.log_path) {
    throw new ApiError(404, 'LOG_NOT_AVAILABLE', '任务尚未生成日志');
  }
  if (isDemoId(job.server_id)) {
    return demoReadChunk(job, endInput, bytes);
  }
  const cfg = getServerConnectConfig(job.server_id);
  const size = await statLogSize(cfg, job.log_path);
  if (size === null) {
    return { start: 0, end: 0, size: null, data: '' };
  }
  const end = Math.min(endInput ?? size, size);
  const start = Math.max(0, end - bytes);
  const result = await readLogRange(cfg, job.log_path, start, end);
  return {
    start,
    end: start + result.data.length,
    size,
    data: result.data.toString('base64'),
  };
}

jobsRouter.get('/:id/logs/tail', async (req, res) => {
  const query = parseBody(chunkQuerySchema, req.query);
  res.json(await readChunk(req.params.id, undefined, query.bytes));
});

jobsRouter.get('/:id/logs/chunk', async (req, res) => {
  const query = parseBody(chunkQuerySchema, req.query);
  res.json(await readChunk(req.params.id, query.end, query.bytes));
});

jobsRouter.get('/:id/logs/download', async (req, res) => {
  const job = getJobRow(req.params.id);
  if (!job) throw notFound('任务');
  if (!job.log_path) throw new ApiError(404, 'LOG_NOT_AVAILABLE', '任务尚未生成日志');
  if (isDemoId(job.server_id)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="job-${job.id.slice(0, 8)}.log"`);
    res.send(demoLogDownloadText(job));
    return;
  }
  const result = await execOnJobServer(job, `cat ${shq(job.log_path)}`, 60_000, 64 * 1024 * 1024);
  const text = stripAnsi(result.stdout);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="job-${job.id.slice(0, 8)}.log"`);
  res.send(result.code === null ? `${text}\n\n[日志超过 64 MB，已截断；请直接在服务器上查看完整文件]\n` : text);
});