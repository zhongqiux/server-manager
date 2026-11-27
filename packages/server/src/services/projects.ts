import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  IgnoreExplainResult,
  ProjectDTO,
  ProjectInput,
  ProjectScanResult,
} from '@sm/shared';
import { prepare } from '../db/index.ts';
import { isDemoId } from '../demo/ids.ts';
import { demoProjectScan } from '../demo/fixtures.ts';
import { ApiError, notFound } from '../errors.ts';
import { buildIgnoreMatcher } from '../sync/ignore.ts';
import { scanLocalFiles, toScanResult } from '../sync/localscan.ts';

export type ProjectRow = {
  id: string;
  name: string;
  local_root: string;
  ignore_extra_json: string;
  exec_bit_policy: string;
  created_at: number;
  updated_at: number;
  target_count?: number;
};

const PROJECT_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM targets t WHERE t.project_id = p.id) AS target_count
  FROM projects p
`;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function rowToDto(row: ProjectRow): ProjectDTO {
  return {
    id: row.id,
    name: row.name,
    localRoot: row.local_root,
    ignoreExtra: parseJson<string[]>(row.ignore_extra_json, []),
    execBitPolicy: row.exec_bit_policy === 'all755' ? 'all755' : 'auto',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    targetCount: Number(row.target_count ?? 0),
  };
}

export function getProjectRow(id: string): ProjectRow | undefined {
  return prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as unknown as ProjectRow | undefined;
}

function requireProjectRow(id: string): ProjectRow {
  const row = getProjectRow(id);
  if (!row) throw notFound('项目');
  return row;
}

export function listProjects(): ProjectDTO[] {
  const rows = prepare(`${PROJECT_SELECT} ORDER BY p.created_at ASC`).all() as unknown as ProjectRow[];
  return rows.map(rowToDto);
}

export function getProjectDto(id: string): ProjectDTO {
  return rowToDto(requireProjectRow(id));
}

function normalizeLocalRoot(localRoot: string): string {
  const trimmed = localRoot.trim();
  if (!trimmed) throw new ApiError(400, 'LOCAL_ROOT_INVALID', '请填写本地目录');
  if (!path.isAbsolute(trimmed)) {
    const example = process.platform === 'win32' ? 'D:\\code\\my-project' : '/Users/you/code/my-project';
    throw new ApiError(400, 'LOCAL_ROOT_INVALID', `本地目录必须是绝对路径，例如 ${example}`);
  }
  const resolved = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new ApiError(400, 'LOCAL_ROOT_INVALID', `本地目录不存在或无法访问：${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new ApiError(400, 'LOCAL_ROOT_INVALID', '本地目录指向的不是文件夹');
  }
  return resolved;
}

function normalizeExtras(extras: string[] | undefined): string[] {
  return (extras ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.startsWith('#'))
    .slice(0, 200);
}

function mapUniqueError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('UNIQUE constraint failed: projects.name')) {
    throw new ApiError(409, 'NAME_TAKEN', '项目名称已存在');
  }
  throw err;
}

export function createProject(input: ProjectInput): ProjectDTO {
  const name = input.name.trim();
  const localRoot = normalizeLocalRoot(input.localRoot);
  const ignoreExtra = normalizeExtras(input.ignoreExtra);
  const execBitPolicy = input.execBitPolicy === 'all755' ? 'all755' : 'auto';
  const id = randomUUID();
  const now = Date.now();
  try {
    prepare(
      `INSERT INTO projects (id, name, local_root, ignore_extra_json, exec_bit_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, localRoot, JSON.stringify(ignoreExtra), execBitPolicy, now, now);
  } catch (err) {
    mapUniqueError(err);
  }
  return getProjectDto(id);
}

export function updateProject(id: string, patch: Partial<ProjectInput>): ProjectDTO {
  const row = requireProjectRow(id);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name.trim());
  }
  if (patch.localRoot !== undefined) {
    sets.push('local_root = ?');
    params.push(normalizeLocalRoot(patch.localRoot));
  }
  if (patch.ignoreExtra !== undefined) {
    sets.push('ignore_extra_json = ?');
    params.push(JSON.stringify(normalizeExtras(patch.ignoreExtra)));
  }
  if (patch.execBitPolicy !== undefined) {
    sets.push('exec_bit_policy = ?');
    params.push(patch.execBitPolicy === 'all755' ? 'all755' : 'auto');
  }

  if (sets.length === 0) return rowToDto(row);

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);
  try {
    prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    mapUniqueError(err);
  }
  return getProjectDto(id);
}

export function deleteProject(id: string): { ok: true; deletedTargets: number } {
  requireProjectRow(id);
  const targetCount = Number(
    (prepare('SELECT COUNT(*) AS c FROM targets WHERE project_id = ?').get(id) as { c: number }).c,
  );
  prepare('DELETE FROM projects WHERE id = ?').run(id);
  return { ok: true, deletedTargets: targetCount };
}

function ensureLocalRootReadable(row: ProjectRow): void {
  try {
    const stat = fs.statSync(row.local_root);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ApiError(400, 'LOCAL_ROOT_INVALID', `本地目录不存在或无法访问：${row.local_root}`);
  }
}

export async function scanProject(id: string): Promise<ProjectScanResult> {
  const row = requireProjectRow(id);
  if (isDemoId(row.id)) return demoProjectScan(row);
  ensureLocalRootReadable(row);
  const matcher = buildIgnoreMatcher({ projectExtra: parseJson<string[]>(row.ignore_extra_json, []) });
  const scan = await scanLocalFiles(row.local_root, matcher);
  return toScanResult(scan);
}

export function explainProjectIgnore(id: string, relPath: string, targetId?: string): IgnoreExplainResult {
  const row = requireProjectRow(id);
  let targetExtra: string[] = [];
  if (targetId) {
    const target = prepare('SELECT sync_config_json FROM targets WHERE id = ? AND project_id = ?').get(
      targetId,
      id,
    ) as { sync_config_json: string } | undefined;
    if (!target) throw notFound('目标');
    const cfg = parseJson<{ extraIgnores?: string[] }>(target.sync_config_json, {});
    targetExtra = cfg.extraIgnores ?? [];
  }
  const matcher = buildIgnoreMatcher({
    projectExtra: parseJson<string[]>(row.ignore_extra_json, []),
    targetExtra,
  });
  const isDir = relPath.endsWith('/');
  return matcher.explain(relPath, isDir);
}