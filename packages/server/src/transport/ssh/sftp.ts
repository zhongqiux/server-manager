import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Client, SFTPWrapper, Stats } from 'ssh2';

const SFTP_TIMEOUT_MS = 20_000;

export type RemoteDirEntry = {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
};

function isNotFound(err: NodeJS.ErrnoException): boolean {
  const code = (err as { code?: string | number }).code;
  return code === 2 || code === 'ENOENT' || /no such file/i.test(err.message ?? '');
}

const clientSftps = new WeakMap<Client, Set<SFTPWrapper>>();

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SFTP 通道建立超时（${SFTP_TIMEOUT_MS}ms）`)), SFTP_TIMEOUT_MS);
    client.sftp((err, sftp) => {
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      let set = clientSftps.get(client);
      if (!set) {
        set = new Set();
        clientSftps.set(client, set);
      }
      set.add(sftp);
      resolve(sftp);
    });
  });
}

// SFTP 通道不会随调用结束自动关闭；连接池复用同一 SSH 连接时，
// 残留通道会累积到 sshd 的 MaxSessions 上限，必须在空闲时显式关闭。
export function closeSftpChannels(client: Client): void {
  const set = clientSftps.get(client);
  if (!set) return;
  clientSftps.delete(client);
  for (const sftp of set) {
    try {
      sftp.end();
    } catch {
      // 通道可能已被远端关闭
    }
  }
}

export function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        if (isNotFound(err as NodeJS.ErrnoException)) resolve(null);
        else reject(err);
      } else {
        resolve(stats);
      }
    });
  });
}

export function sftpReaddir(sftp: SFTPWrapper, remotePath: string): Promise<RemoteDirEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(
        list.map((item) => ({
          name: Buffer.isBuffer(item.filename) ? item.filename.toString('utf8') : String(item.filename),
          isDir: item.attrs.isDirectory(),
          isLink: item.attrs.isSymbolicLink(),
          size: item.attrs.size,
        })),
      );
    });
  });
}

export function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err && !isNotFound(err as NodeJS.ErrnoException)) reject(err);
      else resolve();
    });
  });
}

// OpenSSH 的标准 SFTP rename 不允许覆盖已存在的目标，必须走 posix-rename 扩展；
// 不支持该扩展的服务器退回「先删目标再重命名」（非原子，但能完成更新）。
export function sftpRenameOverwrite(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  try {
    return new Promise((resolve, reject) => {
      sftp.ext_openssh_rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
  } catch {
    // 服务器未声明 posix-rename@openssh.com
  }
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (!err) {
        resolve();
        return;
      }
      sftpUnlink(sftp, to)
        .then(() => {
          sftp.rename(from, to, (retryErr) => (retryErr ? reject(retryErr) : resolve()));
        })
        .catch(reject);
    });
  });
}

export function sftpChmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (err) => (err ? reject(err) : resolve()));
  });
}

export function sftpUtimes(sftp: SFTPWrapper, remotePath: string, mtimeMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const seconds = mtimeMs / 1000;
    sftp.utimes(remotePath, seconds, seconds, (err) => (err ? reject(err) : resolve()));
  });
}

export async function sftpMkdirp(
  sftp: SFTPWrapper,
  remotePath: string,
  cache?: Set<string>,
): Promise<void> {
  const normalized = remotePath.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  if (normalized === '/') return;
  if (cache?.has(normalized)) return;
  const existing = await sftpStat(sftp, normalized);
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`远程路径已存在且不是目录：${normalized}`);
    cache?.add(normalized);
    return;
  }
  const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  await sftpMkdirp(sftp, parent, cache);
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(normalized, (err) => (err ? reject(err) : resolve()));
  });
  cache?.add(normalized);
}

export type UploadFileOptions = {
  mode?: number;
  mtimeMs?: number;
};

export async function sftpDownloadFile(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  options: { mtimeMs?: number } = {},
): Promise<void> {
  await mkdir(path.dirname(localPath), { recursive: true });
  await pipeline(sftp.createReadStream(remotePath), createWriteStream(localPath));
  if (options.mtimeMs !== undefined && options.mtimeMs > 0) {
    const stamp = new Date(options.mtimeMs);
    await utimes(localPath, stamp, stamp);
  }
}

export async function sftpUploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  options: UploadFileOptions = {},
): Promise<void> {
  const dir = remotePath.slice(0, remotePath.lastIndexOf('/')) || '/';
  const tmpPath = `${dir}/.sm-tmp-${randomBytes(6).toString('hex')}`;
  try {
    await pipeline(
      createReadStream(localPath),
      sftp.createWriteStream(tmpPath, { mode: options.mode ?? 0o644, flags: 'w' }),
    );
    if (options.mode !== undefined) await sftpChmod(sftp, tmpPath, options.mode);
    if (options.mtimeMs !== undefined) await sftpUtimes(sftp, tmpPath, options.mtimeMs);
    await sftpRenameOverwrite(sftp, tmpPath, remotePath);
  } catch (err) {
    await sftpUnlink(sftp, tmpPath).catch(() => {
      // 清理失败不掩盖原始错误
    });
    throw err;
  }
}