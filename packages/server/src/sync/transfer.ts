import fs from 'node:fs/promises';
import path from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import type { SyncAction } from '@sm/shared';
import { sftpDownloadFile, sftpMkdirp, sftpUnlink, sftpUploadFile } from '../transport/ssh/sftp.ts';

export class SyncAbortedError extends Error {
  constructor() {
    super('同步已取消');
    this.name = 'SyncAbortedError';
  }
}

export type TransferOptions = {
  sftp: SFTPWrapper;
  localRoot: string;
  remoteRoot: string;
  actions: readonly SyncAction[];
  execBitPolicy: 'auto' | 'all755';
  preserveMode: boolean;
  concurrency: number;
  signal: AbortSignal;
  onFileDone?: (action: SyncAction) => void;
  onFileFailed?: (action: SyncAction, err: Error) => void;
};

export type TransferResult = {
  files: number;
  bytes: number;
  failures: { rel: string; message: string }[];
};

function modeFor(localMode: number, opts: TransferOptions): number {
  if (opts.execBitPolicy === 'all755') return 0o755;
  if (!opts.preserveMode) return 0o644;
  return (localMode & 0o111) !== 0 ? 0o755 : 0o644;
}

function localPathOf(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

export async function uploadActions(opts: TransferOptions): Promise<TransferResult> {
  const root = opts.remoteRoot.replace(/\/+$/, '') || '/';
  const dirCache = new Set<string>();
  const failures: { rel: string; message: string }[] = [];
  let next = 0;
  let files = 0;
  let bytes = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts.signal.aborted) throw new SyncAbortedError();
      const index = next;
      next += 1;
      if (index >= opts.actions.length) return;
      const action = opts.actions[index]!;
      const remotePath = `${root}/${action.rel}`;
      const parent = remotePath.slice(0, remotePath.lastIndexOf('/')) || '/';
      try {
        await sftpMkdirp(opts.sftp, parent, dirCache);
        const stat = await fs.stat(localPathOf(opts.localRoot, action.rel));
        await sftpUploadFile(opts.sftp, localPathOf(opts.localRoot, action.rel), remotePath, {
          mode: modeFor(stat.mode, opts),
          mtimeMs: action.mtimeMs,
        });
        files += 1;
        bytes += action.size;
        opts.onFileDone?.(action);
      } catch (err) {
        if (opts.signal.aborted) throw new SyncAbortedError();
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ rel: action.rel, message });
        opts.onFileFailed?.(action, err instanceof Error ? err : new Error(message));
        if (failures.length >= 5) {
          throw new Error(`上传失败（${failures.length} 个文件），首个错误：${failures[0]!.rel} — ${failures[0]!.message}`);
        }
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.actions.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} 个文件上传失败，首个：${failures[0]!.rel} — ${failures[0]!.message}`,
    );
  }
  return { files, bytes, failures };
}

export type DeleteOptions = {
  sftp: SFTPWrapper;
  remoteRoot: string;
  actions: readonly SyncAction[];
  concurrency: number;
  signal: AbortSignal;
  onFileDone?: (action: SyncAction) => void;
};

export type DownloadOptions = {
  sftp: SFTPWrapper;
  remoteRoot: string;
  localRoot: string;
  actions: readonly SyncAction[];
  concurrency: number;
  signal: AbortSignal;
  onFileDone?: (action: SyncAction) => void;
};

export async function downloadRemoteActions(opts: DownloadOptions): Promise<{ files: number; bytes: number }> {
  const root = opts.remoteRoot.replace(/\/+$/, '') || '/';
  const failures: { rel: string; message: string }[] = [];
  let next = 0;
  let files = 0;
  let bytes = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts.signal.aborted) throw new SyncAbortedError();
      const index = next;
      next += 1;
      if (index >= opts.actions.length) return;
      const action = opts.actions[index]!;
      const localPath = path.join(opts.localRoot, ...action.rel.split('/'));
      try {
        await sftpDownloadFile(opts.sftp, `${root}/${action.rel}`, localPath, {
          mtimeMs: action.mtimeMs,
        });
        files += 1;
        bytes += action.size;
        opts.onFileDone?.(action);
      } catch (err) {
        if (opts.signal.aborted) throw new SyncAbortedError();
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ rel: action.rel, message });
        if (failures.length >= 5) {
          throw new Error(`下载失败（${failures.length} 个文件），首个错误：${failures[0]!.rel} — ${failures[0]!.message}`);
        }
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.actions.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} 个文件下载失败，首个：${failures[0]!.rel} — ${failures[0]!.message}`,
    );
  }
  return { files, bytes };
}

export async function deleteRemoteActions(opts: DeleteOptions): Promise<{ files: number; bytes: number }> {
  const root = opts.remoteRoot.replace(/\/+$/, '') || '/';
  const failures: { rel: string; message: string }[] = [];
  let next = 0;
  let files = 0;
  let bytes = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts.signal.aborted) throw new SyncAbortedError();
      const index = next;
      next += 1;
      if (index >= opts.actions.length) return;
      const action = opts.actions[index]!;
      try {
        await sftpUnlink(opts.sftp, `${root}/${action.rel}`);
        files += 1;
        bytes += action.size;
        opts.onFileDone?.(action);
      } catch (err) {
        if (opts.signal.aborted) throw new SyncAbortedError();
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ rel: action.rel, message });
        if (failures.length >= 5) {
          throw new Error(`删除失败（${failures.length} 个文件），首个错误：${failures[0]!.rel} — ${failures[0]!.message}`);
        }
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.actions.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} 个文件删除失败，首个：${failures[0]!.rel} — ${failures[0]!.message}`,
    );
  }
  return { files, bytes };
}