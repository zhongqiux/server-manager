import ignore, { type Ignore } from 'ignore';
import {
  DEFAULT_IGNORE_PATTERNS,
  HARD_IGNORE_PATTERNS,
  type IgnoreExplainResult,
  type IgnoreSource,
} from '@sm/shared';

export type IgnoreInput = {
  projectExtra?: string[];
  targetExtra?: string[];
};

export type RemotePruneRules = {
  names: string[];
  paths: string[];
};

function normalizeRel(rel: string): string {
  let value = rel.replace(/\\/g, '/').trim();
  while (value.startsWith('./')) value = value.slice(2);
  if (value.startsWith('/')) value = value.slice(1);
  while (value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function cleanPatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).map((p) => p.trim()).filter((p) => p.length > 0 && !p.startsWith('#'));
}

function makeMatcher(patterns: readonly string[]): Ignore {
  return ignore().add(patterns);
}

function hasHardIgnore(rel: string, isDir: boolean): boolean {
  const target = isDir ? `${rel}/` : rel;
  return makeMatcher(HARD_IGNORE_PATTERNS).ignores(target);
}

function firstMatchingRule(patterns: readonly string[], rel: string, isDir: boolean): string | null {
  const target = isDir ? `${rel}/` : rel;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (makeMatcher([pattern]).ignores(target)) return pattern;
  }
  return patterns.find((p) => p.startsWith('!')) ?? null;
}

export class IgnoreMatcher {
  private readonly defaults: string[];
  private readonly project: string[];
  private readonly target: string[];
  private readonly combined: Ignore;

  constructor(input: IgnoreInput = {}) {
    this.defaults = [...DEFAULT_IGNORE_PATTERNS];
    this.project = cleanPatterns(input.projectExtra);
    this.target = cleanPatterns(input.targetExtra);
    this.combined = makeMatcher([...HARD_IGNORE_PATTERNS, ...this.defaults, ...this.project, ...this.target]);
  }

  patternSources(): {
    hard: readonly string[];
    defaults: readonly string[];
    project: readonly string[];
    target: readonly string[];
  } {
    return {
      hard: HARD_IGNORE_PATTERNS,
      defaults: this.defaults,
      project: this.project,
      target: this.target,
    };
  }

  isIgnored(rel: string, isDir = false): boolean {
    const normalized = normalizeRel(rel);
    if (!normalized) return false;
    if (hasHardIgnore(normalized, isDir)) return true;
    return this.combined.ignores(isDir ? `${normalized}/` : normalized);
  }

  explain(rel: string, isDir = false): IgnoreExplainResult {
    const normalized = normalizeRel(rel);
    if (!normalized) return { path: normalized, ignored: false, rule: null, source: null };
    if (hasHardIgnore(normalized, isDir)) {
      return {
        path: normalized,
        ignored: true,
        rule: firstMatchingRule([...HARD_IGNORE_PATTERNS], normalized, isDir),
        source: 'hard',
      };
    }
    const ignored = this.combined.ignores(isDir ? `${normalized}/` : normalized);
    if (!ignored) return { path: normalized, ignored: false, rule: null, source: null };
    const sources: { source: IgnoreSource; patterns: string[] }[] = [
      { source: 'target', patterns: this.target },
      { source: 'project', patterns: this.project },
      { source: 'default', patterns: this.defaults },
    ];
    for (const { source, patterns } of sources) {
      if (makeMatcher(patterns).ignores(isDir ? `${normalized}/` : normalized)) {
        return { path: normalized, ignored: true, rule: firstMatchingRule(patterns, normalized, isDir), source };
      }
    }
    return { path: normalized, ignored: true, rule: null, source: null };
  }
}

export function buildIgnoreMatcher(input: IgnoreInput = {}): IgnoreMatcher {
  return new IgnoreMatcher(input);
}

type SimplePruneRule = { kind: 'name' | 'path'; value: string };

function simplePruneRule(raw: string): SimplePruneRule | null {
  const pattern = raw.trim();
  if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) return null;
  const anchored = pattern.startsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!body || /[*?[\]{}\\]/.test(body)) return null;
  if (body.includes('/')) {
    return anchored ? { kind: 'path', value: body } : null;
  }
  return { kind: anchored ? 'path' : 'name', value: body };
}

/**
 * 生成可安全下发到远端 find 的剪枝规则。
 * 目录名模式（如 node_modules/）仅在没有任何 ! 取反规则时剪枝，
 * 避免误剪被深层取反重新纳入的目录；路径模式会先用完整匹配器确认确实被忽略。
 */
export function buildRemotePruneRules(
  matcher: IgnoreMatcher,
  dataDirRel?: string | null,
): RemotePruneRules {
  const sources = matcher.patternSources();
  const all = [...sources.hard, ...sources.defaults, ...sources.project, ...sources.target];
  const hasNegation = all.some((pattern) => pattern.trim().startsWith('!'));
  const names = new Set<string>();
  const paths = new Set<string>();

  const add = (raw: string, hard: boolean): void => {
    const rule = simplePruneRule(raw);
    if (!rule) return;
    if (rule.kind === 'name') {
      if (hard || !hasNegation) names.add(rule.value);
      return;
    }
    if (hard || matcher.isIgnored(rule.value, true)) paths.add(rule.value);
  };

  for (const pattern of sources.hard) add(pattern, true);
  for (const pattern of sources.defaults) add(pattern, false);
  for (const pattern of sources.project) add(pattern, false);
  for (const pattern of sources.target) add(pattern, false);

  const dataDir = (dataDirRel ?? '').replace(/^\/+|\/+$/g, '');
  if (dataDir) paths.add(dataDir);

  const sortedPaths = [...paths].sort();
  return {
    names: [...names].sort(),
    paths: sortedPaths.filter(
      (value) => !sortedPaths.some((parent) => parent !== value && value.startsWith(`${parent}/`)),
    ),
  };
}