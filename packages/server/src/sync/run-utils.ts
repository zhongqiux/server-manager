import type { SyncMode, SyncRunEvent, SyncRunStatus } from '@sm/shared';
import { publishGlobal } from '../realtime/events-bus.ts';
import { runBus } from '../realtime/runbus.ts';
import { getSyncRunDto, updateSyncRun } from '../services/sync.ts';

export type StartSyncInput = {
  targetId: string;
  dryRun?: boolean;
  sourceTargetId?: string;
  confirmTargetName?: string;
};

export const activeRuns = new Map<string, { targetId: string; controller: AbortController }>();
export const activeByTarget = new Map<string, string>();

export function isTargetBusy(targetId: string): boolean {
  return activeByTarget.has(targetId);
}

export function registerActiveRun(runId: string, targetId: string, controller: AbortController): void {
  activeRuns.set(runId, { targetId, controller });
  activeByTarget.set(targetId, runId);
}

export function unregisterActiveRun(runId: string): void {
  const active = activeRuns.get(runId);
  if (active) activeByTarget.delete(active.targetId);
  activeRuns.delete(runId);
}

export function publish(runId: string, event: SyncRunEvent): void {
  runBus.publish(runId, event);
}

export function setStatus(runId: string, status: SyncRunStatus): void {
  updateSyncRun(runId, { status });
  publish(runId, { type: 'status', runId, status });
}

export function logLine(runId: string, level: 'info' | 'warn' | 'error', message: string): void {
  publish(runId, { type: 'log', runId, level, message, ts: Date.now() });
}

export function publishSyncSummary(runId: string): void {
  const dto = getSyncRunDto(runId);
  publishGlobal({
    type: 'sync.summary',
    runId,
    targetId: dto.targetId,
    mode: dto.mode as SyncMode,
    status: dto.status,
    counts: dto.counts,
  });
}

export function createFinisher(runId: string): (
  status: SyncRunStatus,
  options?: { error?: string | null; stats?: unknown },
) => void {
  let finished = false;
  return (status, options = {}) => {
    if (finished) return;
    finished = true;
    updateSyncRun(runId, {
      status,
      error: options.error ?? null,
      statsJson: options.stats === undefined ? undefined : JSON.stringify(options.stats),
      finishedAt: Date.now(),
    });
    const dto = getSyncRunDto(runId);
    publish(runId, { type: 'done', runId, status, counts: dto.counts, error: dto.error });
    publishSyncSummary(runId);
    unregisterActiveRun(runId);
  };
}

const OUTPUT_TAIL_LIMIT = 16 * 1024;
const OUTPUT_FLUSH_MS = 600;

export class OutputTail {
  private text = '';
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  append(line: string): void {
    this.text += `${line}\n`;
    if (this.text.length > OUTPUT_TAIL_LIMIT) {
      this.text = this.text.slice(-OUTPUT_TAIL_LIMIT);
    }
    if (this.timer) return;
    const wait = Math.max(0, OUTPUT_FLUSH_MS - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lastFlush = Date.now();
    updateSyncRun(this.runId, { outputTail: this.text });
  }
}