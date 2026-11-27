import { describe, expect, it } from 'vitest';
import { buildIgnoreMatcher } from './ignore.ts';

describe('IgnoreMatcher', () => {
  it('默认忽略 node_modules 与 *.log', () => {
    const matcher = buildIgnoreMatcher();
    expect(matcher.isIgnored('node_modules/pkg/index.js')).toBe(true);
    expect(matcher.isIgnored('logs/run.log')).toBe(true);
    expect(matcher.isIgnored('train.py')).toBe(false);
  });

  it('根锚定 /data/ 不会误伤 src/data/', () => {
    const matcher = buildIgnoreMatcher();
    expect(matcher.isIgnored('data/raw.bin', true)).toBe(true);
    expect(matcher.isIgnored('data/sample.csv')).toBe(true);
    expect(matcher.isIgnored('src/data/sample.csv')).toBe(false);
  });

  it('项目级 ! 取反可恢复被默认规则忽略的文件', () => {
    const matcher = buildIgnoreMatcher({ projectExtra: ['!keep.log'] });
    expect(matcher.isIgnored('keep.log')).toBe(false);
    expect(matcher.isIgnored('other.log')).toBe(true);
  });

  it('硬黑名单不可被项目规则取消', () => {
    const matcher = buildIgnoreMatcher({ projectExtra: ['!.git/'] });
    expect(matcher.isIgnored('.git/config')).toBe(true);
    expect(matcher.explain('.git/config').source).toBe('hard');
  });

  it('目标级规则生效并可解释来源', () => {
    const matcher = buildIgnoreMatcher({ targetExtra: ['checkpoints/'] });
    const result = matcher.explain('checkpoints/', true);
    expect(result.ignored).toBe(true);
    expect(result.source).toBe('target');
    expect(result.rule).toBe('checkpoints/');
  });

  it('根锚定的数据目录规则只排除顶层路径', () => {
    const matcher = buildIgnoreMatcher({ targetExtra: ['/datasets/raw/'] });
    expect(matcher.isIgnored('datasets/raw/sample.csv')).toBe(true);
    expect(matcher.isIgnored('src/datasets/raw/sample.csv')).toBe(false);
  });

  it('未命中时 explain 返回未忽略', () => {
    const matcher = buildIgnoreMatcher({ projectExtra: ['backup/'] });
    expect(matcher.explain('src/train.py').ignored).toBe(false);
  });
});