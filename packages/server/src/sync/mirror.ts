import ignore, { type Ignore } from 'ignore';
import type { SyncAction } from '@sm/shared';
import { ApiError } from '../errors.ts';
import type { RemoteEntry } from './manifest.ts';

export const MIRROR_HARD_PROTECT = ['.git', '.git/', '.sm-tmp-*'];

export type OrphanPlanOptions = {
  localRels: ReadonlySet<string>;
  remoteFiles: ReadonlyMap<string, RemoteEntry>;
  isIgnored: (rel: string) => boolean;
  dataDirRel?: string | null;
  protectGlobs?: readonly string[];
};

export type OrphanPlan = {
  actions: SyncAction[];
  protectedSkipped: number;
  deleteBytes: number;
  protectedSample: string[];
};

export function relativeDataDir(remoteCodeDir: string, dataDir?: string | null): string | null {
  if (!dataDir) return null;
  const root = remoteCodeDir.replace(/\/+$/, '') || '/';
  const data = dataDir.replace(/\/+$/, '');
  if (!data.startsWith(`${root}/`)) return null;
  const rel = data.slice(root.length + 1).replace(/^\/+|\/+$/g, '');
  return rel || null;
}

function buildProtector(dataDirRel: string | null | undefined, protectGlobs: readonly string[] | undefined): Ignore {
  const patterns = [...MIRROR_HARD_PROTECT, ...(protectGlobs ?? [])]
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (dataDirRel) patterns.push(`${dataDirRel.replace(/^\/+|\/+$/g, '')}/`);
  return ignore().add(patterns);
}

export function planOrphans(options: OrphanPlanOptions): OrphanPlan {
  const protector = buildProtector(options.dataDirRel, options.protectGlobs);
  const actions: SyncAction[] = [];
  const protectedSample: string[] = [];
  let protectedSkipped = 0;
  let deleteBytes = 0;

  for (const [rel, entry] of options.remoteFiles) {
    if (options.localRels.has(rel)) continue;
    const segments = rel.split('/');
    const unsafe =
      rel.startsWith('/') || segments.some((segment) => segment === '..' || segment === '.' || segment === '');
    if (unsafe || protector.ignores(rel) || options.isIgnored(rel)) {
      protectedSkipped += 1;
      if (protectedSample.length < 8) protectedSample.push(rel);
      continue;
    }
    actions.push({ rel, op: 'delete', reason: 'orphan', size: entry.size, mtimeMs: entry.mtimeMs });
    deleteBytes += entry.size;
  }

  actions.sort((a, b) => a.rel.localeCompare(b.rel));
  return { actions, protectedSkipped, deleteBytes, protectedSample };
}

export function validateMirrorRoot(remoteCodeDir: string, homeDir?: string | null): void {
  const fail = (reason: string): never => {
    throw new ApiError(400, 'MIRROR_ROOT_UNSAFE', `镜像删除已阻止：${reason}`);
  };
  const dir = remoteCodeDir.replace(/\/+/g, '/');
  if (!dir.startsWith('/')) fail('远程代码目录必须是绝对路径');
  const cleaned = dir.replace(/\/+$/, '') || '/';
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) fail('路径不能包含 . 或 ..');
  if (cleaned === '/') fail('不能以根目录作为同步目标');
  if (cleaned === '/tmp') fail('不能直接以 /tmp 作为同步目标');
  if (parts.length < 2) fail('目录层级过浅');
  if (homeDir) {
    const home = homeDir.replace(/\/+/g, '/').replace(/\/+$/, '');
    if (home && cleaned === home) fail(`不能直接以用户主目录 ${home} 作为同步目标`);
  }
}