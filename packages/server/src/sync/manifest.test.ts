import { describe, expect, it } from 'vitest';
import { buildIgnoreMatcher, buildRemotePruneRules } from './ignore.ts';
import { findManifestCommand } from './manifest.ts';

describe('buildRemotePruneRules', () => {
  it('默认忽略目录生成远端剪枝规则', () => {
    const rules = buildRemotePruneRules(buildIgnoreMatcher());
    expect(rules.names).toEqual(
      expect.arrayContaining(['.git', 'node_modules', '__pycache__', '.venv', '.ipynb_checkpoints']),
    );
    expect(rules.paths).toContain('data');
  });

  it('数据目录与自定义忽略目录始终剪枝', () => {
    const rules = buildRemotePruneRules(
      buildIgnoreMatcher({ projectExtra: ['checkpoints/'], targetExtra: ['cache/'] }),
      'datasets/raw',
    );
    expect(rules.names).toContain('checkpoints');
    expect(rules.names).toContain('cache');
    expect(rules.paths).toContain('datasets/raw');
    expect(rules.paths).toContain('data');
  });

  it('存在 ! 取反规则时不按目录名剪枝，但保留数据目录与精确忽略路径', () => {
    const rules = buildRemotePruneRules(
      buildIgnoreMatcher({ projectExtra: ['!keep.log', '!node_modules/'] }),
      'runs/exp-1',
    );
    expect(rules.names).toEqual(['.git']);
    expect(rules.paths).toContain('runs/exp-1');
    expect(rules.paths).toContain('data');
  });

  it('嵌套的数据目录只保留父级剪枝路径', () => {
    const rules = buildRemotePruneRules(buildIgnoreMatcher(), 'data/raw');
    expect(rules.paths).toContain('data');
    expect(rules.paths).not.toContain('data/raw');
  });
});

describe('findManifestCommand', () => {
  it('把剪枝规则拼入 find 表达式并正确引用路径', () => {
    const command = findManifestCommand('/home/u/my proj', {
      names: ['node_modules'],
      paths: ['data/raw'],
    });
    expect(command).toContain("cd -- '/home/u/my proj'");
    expect(command).toContain(
      "find . -mindepth 1 \\( -name 'node_modules' -o -path './data/raw' \\) -prune -o ! -type d ! -type l",
    );
  });

  it('无剪枝规则时保持原有命令', () => {
    expect(findManifestCommand('/srv/proj')).toBe(
      "cd -- '/srv/proj' 2>/dev/null && find . -mindepth 1 ! -type d ! -type l -printf '%P\\0%s\\0%T@\\0' 2>/dev/null",
    );
  });
});