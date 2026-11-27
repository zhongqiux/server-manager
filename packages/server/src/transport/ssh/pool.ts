import type { Client } from 'ssh2';
import { createLogger } from '../../logger.ts';
import type { ExecOptions, ExecResult, SshConnectConfig } from '../types.ts';
import { connectSsh } from './client.ts';
import { runExec } from './exec.ts';
import { closeSftpChannels } from './sftp.ts';

const log = createLogger('ssh-pool');
const IDLE_MS = 60_000;

export type PoolEntry = {
  client: Client;
  fingerprint: string | null;
  lastUsedAt: number;
  active: number;
};

const entries = new Map<string, Promise<PoolEntry>>();

export async function acquire(cfg: SshConnectConfig): Promise<PoolEntry> {
  const existing = entries.get(cfg.serverId);
  if (existing) {
    const entry = await existing.catch(() => null);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return entry;
    }
  }

  let promise: Promise<PoolEntry>;
  promise = (async () => {
    const { client, fingerprint } = await connectSsh(cfg);
    const entry: PoolEntry = { client, fingerprint, lastUsedAt: Date.now(), active: 0 };
    client.on('error', (err: Error) => {
      log.warn(`连接错误 ${cfg.serverId}`, { message: err.message });
    });
    client.on('close', () => {
      if (entries.get(cfg.serverId) === promise) entries.delete(cfg.serverId);
    });
    log.info(`SSH 连接已建立 ${cfg.username}@${cfg.host}:${cfg.port}`);
    return entry;
  })();
  entries.set(cfg.serverId, promise);

  try {
    return await promise;
  } catch (err) {
    if (entries.get(cfg.serverId) === promise) entries.delete(cfg.serverId);
    throw err;
  }
}

export async function withClient<T>(cfg: SshConnectConfig, fn: (client: Client) => Promise<T>): Promise<T> {
  const entry = await acquire(cfg);
  entry.lastUsedAt = Date.now();
  entry.active += 1;
  try {
    return await fn(entry.client);
  } finally {
    entry.active -= 1;
    entry.lastUsedAt = Date.now();
    if (entry.active === 0) closeSftpChannels(entry.client);
  }
}

export async function execRemote(
  cfg: SshConnectConfig,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  return withClient(cfg, (client) => runExec(client, command, options));
}

export function invalidate(serverId: string): void {
  const pending = entries.get(serverId);
  entries.delete(serverId);
  if (!pending) return;
  pending
    .then((entry) => entry.client.end())
    .catch(() => {
      // 连接建立失败时无需关闭
    });
}

export function shutdownPool(): void {
  for (const serverId of [...entries.keys()]) invalidate(serverId);
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [serverId, pending] of [...entries.entries()]) {
    pending
      .then((entry) => {
        if (entry.active === 0 && now - entry.lastUsedAt > IDLE_MS) {
          log.info(`回收空闲连接 ${serverId}`);
          invalidate(serverId);
        }
      })
      .catch(() => {
        // 失败条目会被 acquire 清理
      });
  }
}, 30_000);
sweeper.unref();