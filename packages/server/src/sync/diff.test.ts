import { describe, expect, it } from 'vitest';
import { diffLocalToRemote } from './diff.ts';
import type { LocalFile } from './localscan.ts';
import type { RemoteEntry } from './manifest.ts';

function local(rel: string, size: number, mtimeMs: number): LocalFile {
  return { rel, size, mtimeMs, mode: 0o100644 };
}

function remote(entries: Record<string, [number, number]>): Map<string, RemoteEntry> {
  return new Map(
    Object.entries(entries).map(([rel, [size, mtimeMs]]) => [rel, { size, mtimeMs }]),
  );
}

describe('diffLocalToRemote', () => {
  it('标记远端缺失的文件为新增', () => {
    const result = diffLocalToRemote([local('a.py', 10, 1000)], new Map());
    expect(result.actions).toEqual([
      { rel: 'a.py', op: 'add', reason: 'missing', size: 10, mtimeMs: 1000 },
    ]);
    expect(result.counts.add).toBe(1);
    expect(result.uploadBytes).toBe(10);
  });

  it('大小不同时判定为更新（size）', () => {
    const result = diffLocalToRemote(
      [local('a.py', 12, 1000)],
      remote({ 'a.py': [10, 1000] }),
    );
    expect(result.actions[0]?.op).toBe('update');
    expect(result.actions[0]?.reason).toBe('size');
    expect(result.counts.updateSize).toBe(1);
    expect(result.uploadBytes).toBe(12);
  });

  it('mtime 在 2s 容差内视为相同', () => {
    const result = diffLocalToRemote(
      [local('a.py', 10, 1000)],
      remote({ 'a.py': [10, 2500] }),
    );
    expect(result.actions).toHaveLength(0);
    expect(result.counts.same).toBe(1);
  });

  it('mtime 超出容差判定为更新（mtime）', () => {
    const result = diffLocalToRemote(
      [local('a.py', 10, 5000)],
      remote({ 'a.py': [10, 1000] }),
    );
    expect(result.actions[0]?.reason).toBe('mtime');
    expect(result.counts.updateMtime).toBe(1);
  });

  it('sizeOnly 模式忽略 mtime 差异', () => {
    const result = diffLocalToRemote(
      [local('a.py', 10, 5000)],
      remote({ 'a.py': [10, 1000] }),
      { sizeOnly: true },
    );
    expect(result.actions).toHaveLength(0);
    expect(result.counts.same).toBe(1);
  });

  it('远端 mtime 缺失（SFTP 遍历）时按大小比较', () => {
    const result = diffLocalToRemote(
      [local('a.py', 10, 5000)],
      remote({ 'a.py': [10, 0] }),
    );
    expect(result.actions).toHaveLength(0);
    expect(result.counts.same).toBe(1);
  });

  it('汇总新增与更新的上传字节', () => {
    const result = diffLocalToRemote(
      [local('a.py', 10, 1000), local('b.py', 20, 1000), local('c.py', 30, 1000)],
      remote({ 'b.py': [15, 1000], 'c.py': [30, 1000] }),
    );
    expect(result.counts.add).toBe(1);
    expect(result.counts.updateSize).toBe(1);
    expect(result.counts.same).toBe(1);
    expect(result.uploadBytes).toBe(30);
  });
});