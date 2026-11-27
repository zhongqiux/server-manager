import type { SyncAction, SyncCounts } from '@sm/shared';
import type { LocalFile } from './localscan.ts';
import type { RemoteEntry } from './manifest.ts';

export const DEFAULT_MTIME_TOLERANCE_MS = 2000;

export type DiffOptions = {
  mtimeToleranceMs?: number;
  sizeOnly?: boolean;
};

export type DiffResult = {
  actions: SyncAction[];
  counts: SyncCounts;
  uploadBytes: number;
};

export function emptyCounts(): SyncCounts {
  return {
    add: 0,
    updateSize: 0,
    updateMtime: 0,
    same: 0,
    delete: 0,
    ignored: 0,
    protectedSkipped: 0,
    skippedSymlinks: 0,
  };
}

export function diffLocalToRemote(
  localFiles: readonly LocalFile[],
  remoteFiles: ReadonlyMap<string, RemoteEntry>,
  options: DiffOptions = {},
): DiffResult {
  const tolerance = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
  const counts = emptyCounts();
  const actions: SyncAction[] = [];
  let uploadBytes = 0;

  for (const file of localFiles) {
    const remote = remoteFiles.get(file.rel);
    if (!remote) {
      actions.push({ rel: file.rel, op: 'add', reason: 'missing', size: file.size, mtimeMs: file.mtimeMs });
      counts.add += 1;
      uploadBytes += file.size;
      continue;
    }
    if (remote.size !== file.size) {
      actions.push({ rel: file.rel, op: 'update', reason: 'size', size: file.size, mtimeMs: file.mtimeMs });
      counts.updateSize += 1;
      uploadBytes += file.size;
      continue;
    }
    if (options.sizeOnly || remote.mtimeMs === 0) {
      counts.same += 1;
      continue;
    }
    if (Math.abs(remote.mtimeMs - file.mtimeMs) > tolerance) {
      actions.push({ rel: file.rel, op: 'update', reason: 'mtime', size: file.size, mtimeMs: file.mtimeMs });
      counts.updateMtime += 1;
      uploadBytes += file.size;
      continue;
    }
    counts.same += 1;
  }

  return { actions, counts, uploadBytes };
}