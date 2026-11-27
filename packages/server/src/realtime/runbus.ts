import type { SyncRunEvent } from '@sm/shared';

export type LiveEvent = { seq: number; data: SyncRunEvent };

const HISTORY_LIMIT = 500;
const HISTORY_TTL_MS = 60_000;

class RunBus {
  private history = new Map<string, LiveEvent[]>();
  private seqs = new Map<string, number>();
  private subs = new Map<string, Set<(event: LiveEvent) => void>>();
  private timers = new Map<string, NodeJS.Timeout>();

  publish(runId: string, data: SyncRunEvent): void {
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    const event: LiveEvent = { seq, data };
    const list = this.history.get(runId) ?? [];
    list.push(event);
    if (list.length > HISTORY_LIMIT) list.shift();
    this.history.set(runId, list);
    for (const fn of this.subs.get(runId) ?? []) {
      try {
        fn(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
    if (data.type === 'done') this.scheduleCleanup(runId);
  }

  subscribe(runId: string, fn: (event: LiveEvent) => void): () => void {
    let set = this.subs.get(runId);
    if (!set) {
      set = new Set();
      this.subs.set(runId, set);
    }
    set.add(fn);
    return () => {
      const current = this.subs.get(runId);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) this.subs.delete(runId);
    };
  }

  replay(runId: string, afterSeq: number): LiveEvent[] {
    return (this.history.get(runId) ?? []).filter((event) => event.seq > afterSeq);
  }

  private scheduleCleanup(runId: string): void {
    const existing = this.timers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.history.delete(runId);
      this.seqs.delete(runId);
      this.subs.delete(runId);
      this.timers.delete(runId);
    }, HISTORY_TTL_MS);
    timer.unref();
    this.timers.set(runId, timer);
  }
}

export const runBus = new RunBus();