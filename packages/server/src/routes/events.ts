import { Router } from 'express';
import type { SseEvent } from '@sm/shared';
import { gpuHub } from '../realtime/gpuhub.ts';
import { subscribeGlobal } from '../realtime/events-bus.ts';
import { initSse, sendSse, startHeartbeat } from '../realtime/sse.ts';

export const eventsRouter = Router();

eventsRouter.get('/', (req, res) => {
  initSse(res);
  const stopHeartbeat = startHeartbeat(res);

  const cached = gpuHub.snapshotAll();
  if (cached.length > 0) {
    const initial: SseEvent = { type: 'gpu.snapshot', snapshots: cached };
    sendSse(res, initial);
  }

  const unsubscribeBus = subscribeGlobal((event: SseEvent) => {
    if (res.writableEnded) return;
    sendSse(res, event);
  });
  const releaseHub = gpuHub.subscribe();

  req.on('close', () => {
    releaseHub();
    unsubscribeBus();
    stopHeartbeat();
  });
});