import type { Response } from 'express';

export function initSse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');
}

export function sendSse(res: Response, data: unknown, id?: number): void {
  if (typeof id === 'number') res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function startHeartbeat(res: Response, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // 连接已断开时忽略
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}