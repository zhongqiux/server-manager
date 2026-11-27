import type { Response } from 'express';
import type { Client } from 'ssh2';
import type { JobLogStreamEvent, JobStatus } from '@sm/shared';
import { isJobTerminal, shq } from '@sm/shared';
import { LOG_TAIL_BYTES } from '../config.ts';
import { createLogger } from '../logger.ts';
import { getJobRow, type JobRow } from '../services/jobs.ts';
import { getServerConnectConfig, getServerRow } from '../services/servers.ts';
import { withClient } from '../transport/ssh/pool.ts';
import { openSftp, sftpStat } from '../transport/ssh/sftp.ts';
import { readLogRange, readRangeSftp, statLogSize } from './logio.ts';

const log = createLogger('job-log');

const RING_LIMIT = 2 * 1024 * 1024;
const QUEUE_LIMIT = 1024 * 1024;
const CATCHUP_LIMIT = 1024 * 1024;
const SNAPSHOT_BYTES = Math.max(16 * 1024, LOG_TAIL_BYTES);
const CHUNK_BYTES = 256 * 1024;
const IDLE_CLOSE_MS = 30_000;

type QueuedEvent = { payload: string; bytes: number; end: number | null };

type Sub = {
  res: Response;
  closed: boolean;
  initialized: boolean;
  blocked: boolean;
  lastWritten: number;
  queue: QueuedEvent[];
  queueBytes: number;
  droppedFrom: number | null;
  droppedTo: number;
  onDrain: () => void;
  onClose: () => void;
};

type Chunk = { start: number; end: number; data: Buffer };

function encodeEvent(event: JobLogStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function encodeEventWithId(event: JobLogStreamEvent, id: number): string {
  return `id: ${id}\n${encodeEvent(event)}`;
}

function writeDirect(res: Response, event: JobLogStreamEvent, id?: number): void {
  try {
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(encodeEvent(event));
  } catch {
    // 连接已断开
  }
}

function parseTailCap(serverId: string): 'gnu' | 'busybox' | 'none' | null {
  const row = getServerRow(serverId);
  if (!row?.caps_json) return null;
  try {
    const caps = JSON.parse(row.caps_json) as { tail?: 'gnu' | 'busybox' | 'none' };
    return caps.tail ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

class LogSession {
  readonly jobId: string;
  readonly serverId: string;
  readonly logPath: string;
  private subs = new Set<Sub>();
  private history: Chunk[] = [];
  private historyBytes = 0;
  private offset = 0;
  private started = false;
  private stopping = false;
  private ending = false;
  private finished = false;
  private streamStop: (() => void) | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private initPromise: Promise<void> | null = null;
  private removeSelf: () => void;

  constructor(job: JobRow, removeSelf: () => void) {
    this.jobId = job.id;
    this.serverId = job.server_id;
    this.logPath = job.log_path ?? '';
    this.removeSelf = removeSelf;
  }

  attach(res: Response, lastOffset: number): () => void {
    if (this.stopping) {
      writeDirect(res, { type: 'end', jobId: this.jobId, reason: 'closed' });
      res.end();
      return () => undefined;
    }
    const sub: Sub = {
      res,
      closed: false,
      initialized: false,
      blocked: false,
      lastWritten: Math.max(0, lastOffset),
      queue: [],
      queueBytes: 0,
      droppedFrom: null,
      droppedTo: 0,
      onDrain: () => this.flushQueue(sub),
      onClose: () => this.detach(sub),
    };
    res.on('drain', sub.onDrain);
    res.on('close', sub.onClose);
    this.subs.add(sub);
    this.clearIdle();
    this.start();
    void this.initSub(sub).catch((err: unknown) => {
      this.endSub(sub, 'error', err instanceof Error ? err.message : String(err));
    });
    return () => this.detach(sub);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.monitor = setInterval(() => {
      void this.checkTerminal();
    }, 1500);
    this.monitor.unref();
    void this.runLoop().catch((err: unknown) => {
      log.warn(`日志会话异常 ${this.jobId}`, {
        message: err instanceof Error ? err.message : String(err),
      });
      void this.finish('error', err instanceof Error ? err.message : String(err));
    });
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        while (!this.stopping && !this.ending) {
          try {
            const cfg = getServerConnectConfig(this.serverId);
            const size = await statLogSize(cfg, this.logPath);
            if (size !== null) {
              this.offset = size;
              return;
            }
          } catch {
            // 连接暂时不可用，稍后重试
          }
          await sleep(1000);
        }
      })();
    }
    return this.initPromise;
  }

  private async checkTerminal(): Promise<void> {
    if (this.ending || this.stopping) return;
    const row = getJobRow(this.jobId);
    if (!row) {
      await this.finish('no_log');
      return;
    }
    if (isJobTerminal(row.status as JobStatus)) {
      await this.finish('job_terminal');
    }
  }

  private async initSub(sub: Sub): Promise<void> {
    if (sub.closed) return;
    await this.ensureInit();
    if (sub.closed || this.stopping) return;
    const cfg = getServerConnectConfig(this.serverId);
    let size = this.offset;

    const last = sub.lastWritten;
    let start: number;
    let offset: number;
    let data: Buffer = Buffer.alloc(0);
    let eventType: 'snapshot' | 'reset' | 'catchup' = 'snapshot';
    let reason = '';
    if (last > 0 && size >= last) {
      if (size - last <= CATCHUP_LIMIT) {
        eventType = 'catchup';
      } else {
        eventType = 'reset';
        reason = 'gap';
      }
    } else if (last > 0 && size < last) {
      eventType = 'reset';
      reason = 'truncated';
    }
    start = eventType === 'catchup' ? last : Math.max(0, size - SNAPSHOT_BYTES);
    offset = size;
    if (size > start) {
      try {
        const result = await readLogRange(cfg, this.logPath, start, size);
        data = result.data;
        size = result.size ?? size;
        offset = Math.min(size, start + data.length);
      } catch (err) {
        this.endSub(sub, 'error', err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (sub.closed) return;

    if (eventType === 'catchup' && data.length > 0) {
      for (let cursor = 0; cursor < data.length; cursor += CHUNK_BYTES) {
        const slice = data.subarray(cursor, Math.min(cursor + CHUNK_BYTES, data.length));
        const end = start + cursor + slice.length;
        this.writeEvent(sub, { type: 'log', jobId: this.jobId, offset: end, data: slice.toString('base64') }, end);
      }
    } else if (eventType === 'reset') {
      this.writeEvent(
        sub,
        {
          type: 'reset',
          jobId: this.jobId,
          start,
          offset,
          size,
          data: data.toString('base64'),
          reason,
        },
        offset,
      );
    } else {
      this.writeEvent(
        sub,
        {
          type: 'snapshot',
          jobId: this.jobId,
          start,
          offset,
          size,
          data: data.toString('base64'),
        },
        offset,
      );
    }

    this.replayHistory(sub);

    sub.initialized = true;

    const row = getJobRow(this.jobId);
    if (!row || isJobTerminal(row.status as JobStatus)) {
      this.endSub(sub, 'job_terminal');
    } else if (this.ending) {
      this.endSub(sub, 'job_terminal');
    }
  }

  private replayHistory(sub: Sub): void {
    for (const chunk of this.history) {
      if (chunk.end <= sub.lastWritten) continue;
      let start = chunk.start;
      let data = chunk.data;
      if (chunk.start > sub.lastWritten) {
        const from = sub.lastWritten + 1;
        const to = chunk.start;
        this.writeEvent(sub, { type: 'gapped', jobId: this.jobId, from, to: to - 1 }, to - 1);
      } else if (chunk.start < sub.lastWritten) {
        const skip = sub.lastWritten - chunk.start;
        start = sub.lastWritten;
        data = chunk.data.subarray(skip);
      }
      if (data.length === 0) continue;
      this.writeEvent(
        sub,
        { type: 'log', jobId: this.jobId, offset: start + data.length, data: data.toString('base64') },
        start + data.length,
      );
    }
  }

  private ingest(data: Buffer): void {
    if (data.length === 0) return;
    const chunk: Chunk = { start: this.offset, end: this.offset + data.length, data };
    this.offset = chunk.end;
    this.history.push(chunk);
    this.historyBytes += data.length;
    while (this.historyBytes > RING_LIMIT && this.history.length > 1) {
      const removed = this.history.shift();
      if (removed) this.historyBytes -= removed.data.length;
    }
    for (const sub of this.subs) {
      if (!sub.initialized || sub.closed) continue;
      this.writeEvent(
        sub,
        { type: 'log', jobId: this.jobId, offset: chunk.end, data: data.toString('base64') },
        chunk.end,
      );
    }
  }

  private writeEvent(sub: Sub, event: JobLogStreamEvent, id: number | null): void {
    if (sub.closed) return;
    const payload = id === null ? encodeEvent(event) : encodeEventWithId(event, id);
    if (sub.blocked) {
      if (sub.droppedFrom !== null) {
        if (id !== null) sub.droppedTo = Math.max(sub.droppedTo, id);
        return;
      }
      if (sub.queueBytes + payload.length > QUEUE_LIMIT) {
        sub.queue = [];
        sub.queueBytes = 0;
        sub.droppedFrom = sub.lastWritten + 1;
        sub.droppedTo = id ?? sub.lastWritten;
        return;
      }
      sub.queue.push({ payload, bytes: payload.length, end: id });
      sub.queueBytes += payload.length;
      return;
    }
    const ok = this.writeRaw(sub, payload, id);
    if (!ok) sub.blocked = true;
  }

  private writeRaw(sub: Sub, payload: string, id: number | null): boolean {
    try {
      const ok = sub.res.write(payload);
      if (id !== null) sub.lastWritten = Math.max(sub.lastWritten, id);
      return ok;
    } catch {
      this.detach(sub);
      return true;
    }
  }

  private flushQueue(sub: Sub): void {
    if (sub.closed) return;
    sub.blocked = false;
    if (sub.droppedFrom !== null) {
      const from = sub.droppedFrom;
      const to = sub.droppedTo;
      sub.droppedFrom = null;
      const payload = encodeEventWithId({ type: 'gapped', jobId: this.jobId, from, to }, to);
      const ok = sub.res.write(payload);
      sub.lastWritten = Math.max(sub.lastWritten, to);
      if (!ok) {
        sub.blocked = true;
        return;
      }
    }
    while (sub.queue.length > 0) {
      const item = sub.queue.shift();
      if (!item) break;
      sub.queueBytes -= item.bytes;
      const ok = this.writeRaw(sub, item.payload, item.end);
      if (!ok) {
        sub.blocked = true;
        return;
      }
    }
  }

  private detach(sub: Sub): void {
    if (sub.closed) return;
    sub.closed = true;
    this.subs.delete(sub);
    try {
      sub.res.off('drain', sub.onDrain);
      sub.res.off('close', sub.onClose);
    } catch {
      // 忽略
    }
    if (this.subs.size === 0 && !this.stopping) {
      this.idleTimer = setTimeout(() => this.closeIdle(), IDLE_CLOSE_MS);
      this.idleTimer.unref();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private closeIdle(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.streamStop?.();
    if (this.monitor) clearInterval(this.monitor);
    this.removeSelf();
  }

  private endSub(sub: Sub, reason: 'job_terminal' | 'no_log' | 'error' | 'closed', message?: string): void {
    if (sub.closed) return;
    while (sub.queue.length > 0) {
      const item = sub.queue.shift();
      if (!item) break;
      try {
        sub.res.write(item.payload);
      } catch {
        break;
      }
    }
    writeDirect(sub.res, { type: 'end', jobId: this.jobId, reason, message });
    try {
      sub.res.end();
    } catch {
      // 忽略
    }
    this.detach(sub);
  }

  private async flushRemaining(): Promise<void> {
    try {
      const cfg = getServerConnectConfig(this.serverId);
      const size = await statLogSize(cfg, this.logPath);
      if (size === null || size <= this.offset) return;
      const end = Math.min(size, this.offset + 4 * 1024 * 1024);
      const result = await readLogRange(cfg, this.logPath, this.offset, end);
      if (result.data.length > 0) this.ingest(result.data);
    } catch {
      // 最终回填失败不影响结束事件
    }
  }

  async finish(reason: 'job_terminal' | 'no_log' | 'error' | 'closed', message?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.ending = true;
    if (this.monitor) clearInterval(this.monitor);
    this.clearIdle();
    this.streamStop?.();
    await sleep(200);
    await this.flushRemaining();
    for (const sub of [...this.subs]) {
      if (reason === 'error') this.endSub(sub, 'error', message);
      else if (reason === 'no_log') this.endSub(sub, 'no_log');
      else if (reason === 'closed') this.endSub(sub, 'closed');
      else this.endSub(sub, 'job_terminal');
    }
    this.stopping = true;
    this.removeSelf();
  }

  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.monitor) clearInterval(this.monitor);
    this.clearIdle();
    this.streamStop?.();
    for (const sub of [...this.subs]) this.endSub(sub, 'closed');
    this.removeSelf();
  }

  private async tailLoop(cfg: ReturnType<typeof getServerConnectConfig>): Promise<void> {
    await withClient(
      cfg,
      (client: Client) =>
        new Promise<void>((resolve, reject) => {
          const command = `tail -c +${this.offset + 1} -f ${shq(this.logPath)} 2>/dev/null`;
          client.exec(command, (err, stream) => {
            if (err) {
              reject(err);
              return;
            }
            let settled = false;
            const done = (): void => {
              if (settled) return;
              settled = true;
              this.streamStop = null;
              resolve();
            };
            this.streamStop = () => {
              try {
                stream.close();
              } catch {
                done();
              }
            };
            stream.on('data', (buf: Buffer) => {
              if (this.ending || this.stopping) return;
              this.ingest(buf);
            });
            stream.stderr.on('data', () => {
              // tail 的 stderr 不影响读取
            });
            stream.on('close', done);
            stream.on('error', (streamErr: Error) => {
              if (settled) return;
              settled = true;
              this.streamStop = null;
              reject(streamErr);
            });
          });
        }),
    );
  }

  private async pollLoop(cfg: ReturnType<typeof getServerConnectConfig>): Promise<void> {
    await withClient(cfg, async (client: Client) => {
      const sftp = await openSftp(client);
      try {
        while (!this.stopping && !this.ending) {
          try {
            const stats = await sftpStat(sftp, this.logPath);
            if (stats) {
              if (stats.size < this.offset) {
                this.offset = stats.size;
              } else if (stats.size > this.offset) {
                const end = Math.min(stats.size, this.offset + CHUNK_BYTES);
                const data = await readRangeSftp(sftp, this.logPath, this.offset, end);
                if (data.length > 0) this.ingest(data);
              }
            }
          } catch {
            // 暂时性读取失败，下个周期重试
          }
          await sleep(1000);
        }
      } finally {
        try {
          sftp.end();
        } catch {
          // 忽略
        }
      }
    });
  }

  private async runLoop(): Promise<void> {
    let failures = 0;
    await this.ensureInit();
    while (!this.stopping && !this.ending) {
      const row = getJobRow(this.jobId);
      if (!row) {
        await this.finish('no_log');
        return;
      }
      if (isJobTerminal(row.status as JobStatus)) {
        await this.finish('job_terminal');
        return;
      }
      const cfg = getServerConnectConfig(this.serverId);
      let size: number | null;
      try {
        size = await statLogSize(cfg, this.logPath);
      } catch {
        await sleep(1000);
        continue;
      }
      if (size === null) {
        await sleep(1000);
        continue;
      }
      if (size < this.offset) this.offset = size;

      const tailCap = parseTailCap(this.serverId);
      if (tailCap === 'none') {
        await this.pollLoop(cfg);
        return;
      }
      try {
        await this.tailLoop(cfg);
        failures = 0;
      } catch (err) {
        failures += 1;
        log.warn(`日志 tail 失败 ${this.jobId}`, {
          message: err instanceof Error ? err.message : String(err),
        });
        if (failures >= 2) {
          await this.pollLoop(cfg);
          return;
        }
      }
      if (this.stopping || this.ending) return;
      await sleep(failures > 0 ? 1000 : 300);
    }
  }
}

async function sendTerminalLog(job: JobRow, res: Response, lastOffset: number): Promise<void> {
  if (!job.log_path) {
    writeDirect(res, { type: 'end', jobId: job.id, reason: 'no_log' });
    return;
  }
  try {
    const cfg = getServerConnectConfig(job.server_id);
    const size = await statLogSize(cfg, job.log_path);
    if (size === null) {
      writeDirect(res, { type: 'end', jobId: job.id, reason: 'no_log' });
      return;
    }
    const start =
      lastOffset > 0 && lastOffset <= size ? lastOffset : Math.max(0, size - SNAPSHOT_BYTES);
    const result = await readLogRange(cfg, job.log_path, start, size);
    writeDirect(
      res,
      {
        type: 'snapshot',
        jobId: job.id,
        start,
        offset: result.size ?? size,
        size: result.size ?? size,
        data: result.data.toString('base64'),
      },
      result.size ?? size,
    );
    writeDirect(res, { type: 'end', jobId: job.id, reason: 'job_terminal' });
  } catch (err) {
    writeDirect(res, {
      type: 'end',
      jobId: job.id,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

class LogHub {
  private sessions = new Map<string, LogSession>();

  attach(job: JobRow, res: Response, lastOffset: number): () => void {
    if (isJobTerminal(job.status as JobStatus) || !job.log_path) {
      void sendTerminalLog(job, res, lastOffset).finally(() => {
        try {
          res.end();
        } catch {
          // 忽略
        }
      });
      return () => undefined;
    }
    let session = this.sessions.get(job.id);
    if (!session) {
      session = new LogSession(job, () => this.sessions.delete(job.id));
      this.sessions.set(job.id, session);
    }
    return session.attach(res, lastOffset);
  }

  async notifyTerminal(jobId: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (session) await session.finish('job_terminal');
  }

  shutdown(): void {
    for (const session of [...this.sessions.values()]) session.shutdown();
    this.sessions.clear();
  }
}

export const logHub = new LogHub();

export function notifyJobTerminal(jobId: string): void {
  void logHub.notifyTerminal(jobId);
}