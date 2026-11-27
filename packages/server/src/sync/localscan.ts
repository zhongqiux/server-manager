import fs from 'node:fs/promises';
import path from 'node:path';
import type { IgnoreSample, ProjectScanEntry, ProjectScanResult } from '@sm/shared';
import type { IgnoreMatcher } from './ignore.ts';

export const MAX_SCAN_FILES = 50_000;

export type LocalFile = {
  rel: string;
  size: number;
  mtimeMs: number;
  mode: number;
};

export type LocalScan = {
  root: string;
  files: LocalFile[];
  dirs: number;
  bytes: number;
  ignoredEntries: number;
  skippedSymlinks: number;
  truncated: boolean;
  durationMs: number;
  topLevel: ProjectScanEntry[];
  ignoredSample: IgnoreSample[];
};

const IGNORE_SAMPLE_LIMIT = 8;

export async function scanLocalFiles(root: string, matcher: IgnoreMatcher): Promise<LocalScan> {
  const startedAt = Date.now();
  const files: LocalFile[] = [];
  const topLevel: ProjectScanEntry[] = [];
  let dirs = 0;
  let bytes = 0;
  let ignoredEntries = 0;
  let skippedSymlinks = 0;
  let truncated = false;
  const ignoredSample: IgnoreSample[] = [];

  const sampleIgnored = (rel: string, isDir: boolean): void => {
    if (ignoredSample.length >= IGNORE_SAMPLE_LIMIT) return;
    const explained = matcher.explain(rel, isDir);
    if (explained.ignored && explained.rule) {
      ignoredSample.push({
        rel: isDir ? `${rel}/` : rel,
        rule: explained.rule,
        source: explained.source ?? 'default',
      });
    }
  };

  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const isTop = relDir === '';
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        if (isTop) topLevel.push({ name: entry.name, type: 'file', ignored: true, size: null });
        continue;
      }
      if (entry.isDirectory()) {
        const ignored = matcher.isIgnored(rel, true);
        if (ignored) {
          ignoredEntries += 1;
          sampleIgnored(rel, true);
          if (isTop) topLevel.push({ name: entry.name, type: 'dir', ignored: true, size: null });
          continue;
        }
        dirs += 1;
        if (isTop) topLevel.push({ name: entry.name, type: 'dir', ignored: false, size: null });
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;

      const ignored = matcher.isIgnored(rel, false);
      if (ignored) {
        ignoredEntries += 1;
        sampleIgnored(rel, false);
        if (isTop) topLevel.push({ name: entry.name, type: 'file', ignored: true, size: null });
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(path.join(root, rel));
      } catch {
        continue;
      }
      bytes += stat.size;
      files.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
      if (isTop) topLevel.push({ name: entry.name, type: 'file', ignored: false, size: stat.size });
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    root,
    files,
    dirs,
    bytes,
    ignoredEntries,
    skippedSymlinks,
    truncated,
    durationMs: Date.now() - startedAt,
    topLevel,
    ignoredSample,
  };
}

export function toScanResult(scan: LocalScan): ProjectScanResult {
  return {
    root: scan.root,
    files: scan.files.length,
    dirs: scan.dirs,
    bytes: scan.bytes,
    ignoredEntries: scan.ignoredEntries,
    skippedSymlinks: scan.skippedSymlinks,
    truncated: scan.truncated,
    durationMs: scan.durationMs,
    topLevel: scan.topLevel,
  };
}