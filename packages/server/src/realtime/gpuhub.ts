import type { GpuSnapshot, ServerStatus } from '@sm/shared';
import { DEMO_MODE, GPU_INTERVAL_MS } from '../config.ts';
import { isDemoId } from '../demo/ids.ts';
import { demoGpuSnapshot } from '../demo/fixtures.ts';
import { refreshDemoJobTelemetry } from '../demo/logs.ts';
import { createLogger } from '../logger.ts';
import { getServerConnectConfig, getServerRow, listServers, setServerStatus } from '../services/servers.ts';
import { classifySshError } from '../transport/ssh/client.ts';
import { collectGpu } from '../transport/ssh/gpu.ts';
import { withClient } from '../transport/ssh/pool.ts';
import { publishGlobal } from './events-bus.ts';

const log = createLogger('gpu');
const IDLE_STOP_MS = 30_000;
const UNSUPPORTED_RECHECK_MS = 60_000;
const BROADCAST_MS = 2_000;
const MAX_CONCURRENT = 4;
const ERROR_BACKOFF_START = 5_000;
const ERROR_BACKOFF_MAX = 60_000;
const RECONCILE_MS = 15_000;

type Entry = {
  serverId: string;
  snapshot: GpuSnapshot | null;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  backoffMs: number;
  unsupportedUntil: number;
};

class GpuHub {
  private entries = new Map<string, Entry>();
  private subscribers = 0;
  private activePolls = 0;
  private started = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;

  start(): void {
    this.started = true;
    if (!DEMO_MODE) return;
    for (const server of listServers()) {
      if (!isDemoId(server.id)) continue;
      const snapshot = demoGpuSnapshot(server.id);
      if (!snapshot) continue;
      this.entries.set(server.id, {
        serverId: server.id,
        snapshot,
        timer: null,
        inFlight: false,
        backoffMs: 0,
        unsupportedUntil: 0,
      });
    }
  }

  stop(): void {
    this.started = false;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.reconcileTimer = null;
    this.broadcastTimer = null;
    this.idleTimer = null;
  }

  getSnapshot(serverId: string): GpuSnapshot | null {
    return this.entries.get(serverId)?.snapshot ?? null;
  }

  snapshotAll(): GpuSnapshot[] {
    const snapshots: GpuSnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (entry.snapshot) snapshots.push(entry.snapshot);
    }
    return snapshots;
  }

  subscribe(): () => void {
    this.subscribers += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.reconcile();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS);
      this.reconcileTimer.unref();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers = Math.max(0, this.subscribers - 1);
      if (this.subscribers === 0) this.scheduleIdleStop();
    };
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subscribers > 0) return;
      for (const entry of this.entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (this.reconcileTimer) {
        clearInterval(this.reconcileTimer);
        this.reconcileTimer = null;
      }
      log.info('所有订阅已断开，暂停 GPU 轮询');
    }, IDLE_STOP_MS);
    this.idleTimer.unref();
  }

  private reconcile(): void {
    if (this.subscribers <= 0) return;
    const servers = listServers();
    const known = new Set<string>();
    for (const server of servers) {
      known.add(server.id);
      let entry = this.entries.get(server.id);
      if (!entry) {
        entry = {
          serverId: server.id,
          snapshot: null,
          timer: null,
          inFlight: false,
          backoffMs: 0,
          unsupportedUntil: 0,
        };
        this.entries.set(server.id, entry);
        this.schedule(entry, 0);
      } else if (!entry.timer && !entry.inFlight) {
        // 空闲暂停后重新订阅：为已有条目恢复轮询
        this.schedule(entry, 0);
      }
    }
    for (const [id, entry] of this.entries) {
      if (known.has(id)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(id);
    }
  }

  private canPoll(): boolean {
    // 最后一个订阅断开后仍保留 IDLE_STOP_MS 宽限，避免刷新页面时反复启停
    return this.started && (this.subscribers > 0 || this.idleTimer !== null);
  }

  private schedule(entry: Entry, delayMs: number): void {
    if (!this.canPoll() || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.poll(entry);
    }, Math.max(0, delayMs));
    entry.timer.unref();
  }

  private async poll(entry: Entry): Promise<void> {
    if (!this.canPoll()) return;
    const now = Date.now();
    if (entry.unsupportedUntil > now) {
      this.schedule(entry, entry.unsupportedUntil - now);
      return;
    }
    if (this.activePolls >= MAX_CONCURRENT || entry.inFlight) {
      this.schedule(entry, 1_000);
      return;
    }

    entry.inFlight = true;
    this.activePolls += 1;
    try {
      if (isDemoId(entry.serverId)) {
        entry.snapshot = demoGpuSnapshot(entry.serverId);
        entry.backoffMs = 0;
        entry.unsupportedUntil = 0;
        refreshDemoJobTelemetry(entry.serverId);
        const row = getServerRow(entry.serverId);
        if (row && row.status !== 'online') {
          setServerStatus(entry.serverId, 'online', '演示数据（合成）', { touchOk: true });
        }
      } else {
        const cfg = getServerConnectConfig(entry.serverId);
        const result = await withClient(cfg, (client) => collectGpu(client));
        entry.backoffMs = 0;
        entry.snapshot = {
          serverId: entry.serverId,
          supported: result.supported,
          reason: result.reason ?? null,
          gpus: result.gpus,
          idleCount: result.gpus.filter((gpu) => gpu.idle).length,
          collectedAt: Date.now(),
          stale: false,
        };
        if (result.supported) {
          entry.unsupportedUntil = 0;
          const row = getServerRow(entry.serverId);
          if (row && row.status !== 'online') setServerStatus(entry.serverId, 'online', null, { touchOk: true });
        } else {
          entry.unsupportedUntil = Date.now() + UNSUPPORTED_RECHECK_MS;
        }
      }
    } catch (err) {
      const info = classifySshError(err);
      entry.backoffMs =
        entry.backoffMs === 0 ? ERROR_BACKOFF_START : Math.min(entry.backoffMs * 2, ERROR_BACKOFF_MAX);
      const fallback: GpuSnapshot = {
        serverId: entry.serverId,
        supported: entry.snapshot?.supported ?? false,
        reason: info.message,
        gpus: entry.snapshot?.gpus ?? [],
        idleCount: entry.snapshot?.idleCount ?? 0,
        collectedAt: entry.snapshot?.collectedAt ?? Date.now(),
        stale: true,
      };
      entry.snapshot = fallback;
      const row = getServerRow(entry.serverId);
      const status: ServerStatus =
        info.code === 'AUTH_FAILED' ? 'auth_failed' : info.code === 'OFFLINE' ? 'offline' : 'error';
      if (row && row.status !== status) setServerStatus(entry.serverId, status, info.message);
      log.warn('GPU 轮询失败', { serverId: entry.serverId, message: info.message, backoffMs: entry.backoffMs });
    } finally {
      entry.inFlight = false;
      this.activePolls -= 1;
      this.queueBroadcast();
      this.schedule(entry, entry.backoffMs || GPU_INTERVAL_MS);
    }
  }

  private queueBroadcast(): void {
    if (this.broadcastTimer || this.subscribers <= 0) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const snapshots = this.snapshotAll();
      if (snapshots.length > 0) publishGlobal({ type: 'gpu.snapshot', snapshots });
    }, BROADCAST_MS);
    this.broadcastTimer.unref();
  }
}

export const gpuHub = new GpuHub();

export function startGpuHub(): void {
  gpuHub.start();
}

export function stopGpuHub(): void {
  gpuHub.stop();
}