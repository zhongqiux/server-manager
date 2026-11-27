import { describe, expect, it } from 'vitest';
import { planOrphans, relativeDataDir, validateMirrorRoot } from './mirror.ts';
import type { RemoteEntry } from './manifest.ts';

function remote(entries: Record<string, number>): Map<string, RemoteEntry> {
  return new Map(Object.entries(entries).map(([rel, size]) => [rel, { size, mtimeMs: 1000 }]));
}

describe('planOrphans', () => {
  it('删除远端孤儿文件并统计字节', () => {
    const plan = planOrphans({
      localRels: new Set(['a.py']),
      remoteFiles: remote({ 'a.py': 10, 'orphan.txt': 5, 'sub/old.bin': 7 }),
      isIgnored: () => false,
    });
    expect(plan.actions.map((action) => action.rel)).toEqual(['orphan.txt', 'sub/old.bin']);
    expect(plan.actions.every((action) => action.op === 'delete' && action.reason === 'orphan')).toBe(true);
    expect(plan.deleteBytes).toBe(12);
    expect(plan.protectedSkipped).toBe(0);
  });

  it('保护 .git、数据目录、忽略规则与自定义 glob', () => {
    const plan = planOrphans({
      localRels: new Set(['a.py']),
      remoteFiles: remote({
        'a.py': 10,
        'orphan.txt': 5,
        '.git/config': 3,
        'data/keep.bin': 4,
        'logs/run.log': 2,
        'protected/keep.txt': 1,
      }),
      isIgnored: (rel) => rel.endsWith('.log'),
      dataDirRel: 'data',
      protectGlobs: ['protected/'],
    });
    expect(plan.actions.map((action) => action.rel)).toEqual(['orphan.txt']);
    expect(plan.protectedSkipped).toBe(4);
    expect(plan.protectedSample).toEqual(
      expect.arrayContaining(['.git/config', 'data/keep.bin', 'logs/run.log', 'protected/keep.txt']),
    );
  });

  it('拒绝包含 .. 的远端路径', () => {
    const plan = planOrphans({
      localRels: new Set(),
      remoteFiles: remote({ '../escape.txt': 1, 'ok.txt': 1 }),
      isIgnored: () => false,
    });
    expect(plan.actions.map((action) => action.rel)).toEqual(['ok.txt']);
    expect(plan.protectedSkipped).toBe(1);
  });
});

describe('relativeDataDir', () => {
  it('数据目录在代码目录内时返回相对路径', () => {
    expect(relativeDataDir('/home/u/proj', '/home/u/proj/data')).toBe('data');
    expect(relativeDataDir('/home/u/proj/', '/home/u/proj/data/raw/')).toBe('data/raw');
  });

  it('数据目录在代码目录外时返回 null', () => {
    expect(relativeDataDir('/home/u/proj', '/mnt/data')).toBeNull();
    expect(relativeDataDir('/home/u/proj', '/home/u/proj2/data')).toBeNull();
    expect(relativeDataDir('/home/u/proj', null)).toBeNull();
  });
});

describe('validateMirrorRoot', () => {
  it('拒绝根目录、/tmp 与过浅路径', () => {
    expect(() => validateMirrorRoot('/')).toThrow('镜像删除已阻止');
    expect(() => validateMirrorRoot('/tmp')).toThrow('镜像删除已阻止');
    expect(() => validateMirrorRoot('/project')).toThrow('目录层级过浅');
    expect(() => validateMirrorRoot('relative/path')).toThrow('绝对路径');
  });

  it('拒绝用户主目录', () => {
    expect(() => validateMirrorRoot('/home/me', '/home/me/')).toThrow('主目录');
  });

  it('接受常见项目目录', () => {
    expect(() => validateMirrorRoot('/home/me/project', '/home/me')).not.toThrow();
    expect(() => validateMirrorRoot('/tmp/project', '/root')).not.toThrow();
  });
});