import { Router } from 'express';
import { z } from 'zod';
import type { SyncRunStatus } from '@sm/shared';
import { cancelDemoSync, isDemoSyncRun, isDemoSyncTarget, startDemoSync } from '../demo/sync.ts';
import { notFound } from '../errors.ts';
import type { LiveEvent } from '../realtime/runbus.ts';
import { runBus } from '../realtime/runbus.ts';
import { initSse, sendSse, startHeartbeat } from '../realtime/sse.ts';
import {
  getSyncRunDto,
  getSyncRunRow,
  isTerminalStatus,
  listSyncRuns,
  rowToSyncRunDto,
  type SyncRunRow,
} from '../services/sync.ts';
import { cancelSyncRun, startSyncRun } from '../sync/engine.ts';
import { parseBody } from './validate.ts';

export const syncRouter = Router();

const startSchema = z.object({
  targetId: z.string().uuid(),
  dryRun: z.boolean().optional(),
  sourceTargetId: z.string().uuid().optional(),
  confirmTargetName: z.string().max(128).optional(),
});

const listQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

syncRouter.post('/runs', (req, res) => {
  const input = parseBody(startSchema, req.body);
  if (isDemoSyncTarget(input.targetId)) {
    res.status(202).json(startDemoSync(input));
    return;
  }
  res.status(202).json(startSyncRun(input));
});

syncRouter.get('/runs', (req, res) => {
  const query = parseBody(listQuerySchema, req.query);
  res.json({ items: listSyncRuns(query) });
});

syncRouter.get('/runs/:id/events', (req, res) => {
  const runId = req.params.id;
  const row = getSyncRunRow(runId);
  if (!row) throw notFound('同步记录');

  initSse(res);
  const parseSeq = (value: unknown): number => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 0;
  };
  const after = parseSeq(req.headers['last-event-id']) || parseSeq(req.query.after);

  let closed = false;
  let sentDone = false;
  let lastSeq = 0;
  let unsubscribe: (() => void) | undefined;
  const stopHeartbeat = startHeartbeat(res);

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    unsubscribe?.();
  };
  const closeWithEnd = (): void => {
    if (closed) return;
    sendSse(res, { type: 'end' });
    shutdown();
    res.end();
  };
  const deliver = (event: LiveEvent): void => {
    if (closed) return;
    lastSeq = Math.max(lastSeq, event.seq);
    sendSse(res, event.data, event.seq);
    if (event.data.type === 'done') {
      sentDone = true;
      closeWithEnd();
    }
  };
  const finalize = (snapshot: SyncRunRow): void => {
    if (closed) return;
    if (!sentDone) {
      const dto = rowToSyncRunDto(snapshot);
      sentDone = true;
      sendSse(res, {
        type: 'done',
        runId,
        status: dto.status,
        counts: dto.counts,
        error: dto.error,
      });
    }
    closeWithEnd();
  };

  req.on('close', shutdown);

  for (const event of runBus.replay(runId, after)) deliver(event);
  if (closed) return;

  if (isTerminalStatus(row.status as SyncRunStatus)) {
    finalize(row);
    return;
  }

  unsubscribe = runBus.subscribe(runId, deliver);
  if (closed) return;

  const fresh = getSyncRunRow(runId) ?? row;
  if (isTerminalStatus(fresh.status as SyncRunStatus)) {
    for (const event of runBus.replay(runId, lastSeq)) deliver(event);
    if (!closed) finalize(fresh);
  }
});

syncRouter.post('/runs/:id/cancel', (req, res) => {
  if (isDemoSyncRun(req.params.id)) {
    res.json(cancelDemoSync(req.params.id));
    return;
  }
  res.json(cancelSyncRun(req.params.id));
});

syncRouter.get('/runs/:id', (req, res) => {
  res.json(getSyncRunDto(req.params.id));
});