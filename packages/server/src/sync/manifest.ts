import type { Client, SFTPWrapper } from 'ssh2';
import { shq, type Caps } from '@sm/shared';
import { ApiError } from '../errors.ts';
import { runExec } from '../transport/ssh/exec.ts';
import { sftpReaddir } from '../transport/ssh/sftp.ts';
import { buildRemotePruneRules, type IgnoreMatcher, type RemotePruneRules } from './ignore.ts';

export type RemoteEntry = { size: number; mtimeMs: number };

export type RemoteManifest = {
  files: Map<string, RemoteEntry>;
  method: 'find' | 'sftp';
  warnings: string[];
  skippedIgnored: number;
};

const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const SFTP_WALK_MAX_FILES = 5000;
const SFTP_WALK_MAX_DEPTH = 32;

export function findManifestCommand(dir: string, prune?: RemotePruneRules): string {
  const conditions: string[] = [];
  for (const name of prune?.names ?? []) conditions.push(`-name ${shq(name)}`);
  for (const rel of prune?.paths ?? []) conditions.push(`-path ${shq(`./${rel}`)}`);
  const pruneExpr = conditions.length ? `\\( ${conditions.join(' -o ')} \\) -prune -o ` : '';
  return `cd -- ${shq(dir)} 2>/dev/null && find . -mindepth 1 ${pruneExpr}! -type d ! -type l -printf '%P\\0%s\\0%T@\\0' 2>/dev/null`;
}

export function parseFindManifest(stdout: string): Map<string, RemoteEntry> {
  const files = new Map<string, RemoteEntry>();
  const parts = stdout.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const rel = parts[i];
    if (!rel) continue;
    const size = Number(parts[i + 1]);
    const mtimeSec = Number(parts[i + 2]);
    if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) continue;
    files.set(rel, { size, mtimeMs: mtimeSec * 1000 });
  }
  return files;
}

async function walkRemote(
  sftp: SFTPWrapper,
  root: string,
  warnings: string[],
  isExcluded: (rel: string, isDir: boolean) => boolean,
): Promise<{ files: Map<string, RemoteEntry>; skippedIgnored: number }> {
  const files = new Map<string, RemoteEntry>();
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
  let skippedDirs = 0;
  let skippedIgnored = 0;
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (dir.depth > SFTP_WALK_MAX_DEPTH) {
      skippedDirs += 1;
      continue;
    }
    let entries;
    try {
      entries = await sftpReaddir(sftp, dir.abs);
    } catch (err) {
      skippedDirs += 1;
      continue;
    }
    for (const entry of entries) {
      const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
      if (entry.isLink) continue;
      if (entry.isDir) {
        if (isExcluded(rel, true)) {
          skippedIgnored += 1;
          continue;
        }
        stack.push({ abs: `${dir.abs}/${entry.name}`, rel, depth: dir.depth + 1 });
        continue;
      }
      if (isExcluded(rel, false)) {
        skippedIgnored += 1;
        continue;
      }
      files.set(rel, { size: entry.size, mtimeMs: 0 });
      if (files.size >= SFTP_WALK_MAX_FILES) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (truncated) {
    warnings.push(`SFTP 清单超过 ${SFTP_WALK_MAX_FILES} 个文件，已截断；建议安装 GNU find 或缩小远程代码目录`);
  }
  if (skippedDirs > 0) warnings.push(`${skippedDirs} 个远端目录无法读取，清单可能不完整`);
  warnings.push('SFTP 遍历模式仅比较文件大小（readdir 不提供可靠 mtime），无法识别仅修改时间的变更');
  return { files, skippedIgnored };
}

export async function readRemoteManifest(opts: {
  client: Client;
  sftp: SFTPWrapper;
  caps: Caps;
  dir: string;
  matcher?: IgnoreMatcher;
  dataDirRel?: string | null;
}): Promise<RemoteManifest> {
  const warnings: string[] = [];
  const dataDirRel = (opts.dataDirRel ?? '').replace(/^\/+|\/+$/g, '') || null;
  const isExcluded = (rel: string, isDir: boolean): boolean => {
    if (dataDirRel && (rel === dataDirRel || rel.startsWith(`${dataDirRel}/`))) return true;
    return Boolean(opts.matcher?.isIgnored(rel, isDir));
  };
  const prune: RemotePruneRules = opts.matcher
    ? buildRemotePruneRules(opts.matcher, dataDirRel)
    : { names: [], paths: dataDirRel ? [dataDirRel] : [] };

  if (opts.caps.find === 'gnu') {
    const result = await runExec(opts.client, findManifestCommand(opts.dir, prune), {
      timeoutMs: 120_000,
      maxBytes: MANIFEST_MAX_BYTES,
    });
    if (result.stderr.includes('输出超过上限')) {
      throw new ApiError(
        502,
        'REMOTE_MANIFEST_TOO_LARGE',
        '远端目录清单超过 16MB（已跳过数据目录与忽略目录），请确认远程代码目录指向的是代码子目录，或把大型数据/缓存目录加入忽略规则',
      );
    }
    if (result.code === 0) {
      const files = new Map<string, RemoteEntry>();
      let skippedIgnored = 0;
      for (const [rel, entry] of parseFindManifest(result.stdout)) {
        if (isExcluded(rel, false)) {
          skippedIgnored += 1;
          continue;
        }
        files.set(rel, entry);
      }
      return { files, method: 'find', warnings, skippedIgnored };
    }
    warnings.push(
      `远端 find 清单失败（退出码 ${result.code}）${result.stderr.trim() ? `：${result.stderr.trim().slice(0, 200)}` : ''}，改用 SFTP 遍历`,
    );
  } else {
    warnings.push('服务器缺少 GNU find，使用 SFTP 目录遍历生成远端清单（大目录较慢）');
  }
  const walked = await walkRemote(opts.sftp, opts.dir, warnings, isExcluded);
  return { ...walked, method: 'sftp', warnings };
}