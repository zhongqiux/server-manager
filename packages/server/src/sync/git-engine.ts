import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Client } from 'ssh2';
import type {
  GitDetectResult,
  GitRepoState,
  GitRunSummary,
  GitSyncConfig,
  GitTargetAction,
  GitTargetState,
  SyncRunDTO,
  TargetSyncConfig,
} from '@sm/shared';
import { shq } from '@sm/shared';
import { prepare } from '../db/index.ts';
import { ApiError, notFound } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { getProjectRow, type ProjectRow } from '../services/projects.ts';
import { getServerConnectConfig } from '../services/servers.ts';
import { getSyncRunDto, getSyncRunRow } from '../services/sync.ts';
import { getTargetRow, type TargetRow } from '../services/targets.ts';
import { runExec, runExecStream } from '../transport/ssh/exec.ts';
import { withClient } from '../transport/ssh/pool.ts';
import { runGit, type GitResult } from './git-process.ts';
import {
  createFinisher,
  isTargetBusy,
  logLine,
  OutputTail,
  registerActiveRun,
  setStatus,
  type StartSyncInput,
} from './run-utils.ts';
import { SyncAbortedError } from './transfer.ts';

const log = createLogger('git-sync');
const DIRTY_LIMIT = 40;
const NETWORK_TIMEOUT_MS = 180_000;
const DEFAULT_COMMIT_TEMPLATE = 'sm: {{project_name}} → {{server_name}}';

type GitConfig = Required<GitSyncConfig>;
type StreamSource = 'stdout' | 'stderr';
type LineSink = (line: string, source: StreamSource) => void;
type Emit = (level: 'info' | 'warn' | 'error', message: string) => void;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function redactUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/(\/\/[^/@\s:]+:)[^@/\s]+@/, '$1***@');
  }
}

function secretsOf(url: string): string[] {
  const values: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (!value || value.length < 3) return;
    values.push(value);
    try {
      values.push(decodeURIComponent(value));
    } catch {
      // 非 URL 编码，保持原样
    }
  };
  try {
    const parsed = new URL(url);
    push(parsed.password);
  } catch {
    // 非标准 URL，走正则兜底
  }
  const match = url.match(/:\/\/([^/@\s:]+):([^@/\s]+)@/);
  if (match) push(match[2]);
  return [...new Set(values)];
}

export function sanitizeGitText(text: string, remoteUrl: string): string {
  let out = text;
  for (const secret of secretsOf(remoteUrl)) {
    out = out.split(secret).join('***');
  }
  return out.replace(/([a-zA-Z][\w+.-]*:\/\/[^/@\s:]+:)[^@/\s]+@/g, '$1***@');
}

function gitConfigOf(target: TargetRow): GitConfig {
  const raw = parseJson<TargetSyncConfig>(target.sync_config_json, {});
  return {
    remoteUrl: (raw.remoteUrl ?? '').trim(),
    branch: (raw.branch ?? '').trim() || 'main',
    remoteName: (raw.remoteName ?? '').trim() || 'origin',
    sourceKind: raw.sourceKind === 'target' ? 'target' : 'local',
    sourceTargetId: raw.sourceTargetId ?? null,
    autoCommitOnSource: raw.autoCommitOnSource ?? true,
    cloneIfMissing: raw.cloneIfMissing ?? true,
    commitMessageTemplate: (raw.commitMessageTemplate ?? '').trim() || DEFAULT_COMMIT_TEMPLATE,
  };
}

function renderCommitMessage(project: ProjectRow, target: TargetRow, cfg: GitConfig): string {
  const now = new Date();
  const values: Record<string, string> = {
    project_name: project.name,
    server_name: target.server_name ?? '远程服务器',
    target_label: target.label || target.server_name || target.id,
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
  };
  return cfg.commitMessageTemplate.replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
    (match, key: string) => values[key] ?? match,
  );
}

function splitDirty(output: string): { dirty: string[]; dirtyCount: number } {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return { dirty: lines.slice(0, DIRTY_LIMIT), dirtyCount: lines.length };
}

function tailText(text: string, limit = 1200): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
}

function localFailure(command: string, result: GitResult, cfg: GitConfig, hint?: string): ApiError {
  const detail = tailText(sanitizeGitText([result.stderr, result.stdout].filter(Boolean).join('\n'), cfg.remoteUrl));
  return new ApiError(
    400,
    'GIT_COMMAND_FAILED',
    `git ${command} 失败：${detail || result.error || `退出码 ${result.code ?? '未知'}`}${hint ? `\n${hint}` : ''}`,
  );
}

function pushFailure(result: { stdout: string; stderr: string; code: number | null }, cfg: GitConfig): ApiError {
  const text = `${result.stdout}\n${result.stderr}`;
  const rejected =
    /non-fast-forward|\[rejected\]|fetch first|Updates were rejected|failed to push some refs/i.test(text);
  const detail = tailText(sanitizeGitText(text, cfg.remoteUrl));
  if (rejected) {
    return new ApiError(
      400,
      'GIT_PUSH_REJECTED',
      `推送被中心仓库拒绝：远端分支包含本地没有的提交（非快进），已中止，未执行任何强制推送。\n${detail}\n` +
        `可选处理：\n1) 先执行 git pull --rebase ${redactUrl(cfg.remoteUrl)} ${cfg.branch} 再重试；\n2) 推送到新分支并在目标机上切换分支；\n3) 改用 SFTP 同步模式。`,
    );
  }
  return new ApiError(
    400,
    'GIT_PUSH_FAILED',
    `推送失败（${redactUrl(cfg.remoteUrl)}，分支 ${cfg.branch}）。常见原因：仓库地址不可达、凭据未配置。\n${detail || '无输出'}`,
  );
}

function zeroRepoState(): GitRepoState {
  return {
    available: false,
    isRepo: false,
    toplevel: null,
    branch: null,
    detached: false,
    head: null,
    dirty: [],
    dirtyCount: 0,
    ahead: null,
    behind: null,
    warnings: [],
  };
}

async function inspectLocalRepo(localRoot: string, cfg: GitConfig): Promise<GitRepoState> {
  const state = zeroRepoState();
  const version = await runGit(['--version'], { cwd: localRoot, timeoutMs: 10_000 });
  if (version.code !== 0) {
    state.warnings.push('本机未安装 git 或 git 不可用');
    return state;
  }
  state.available = true;

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], {
    cwd: localRoot,
    timeoutMs: 10_000,
  });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return state;
  }
  state.isRepo = true;

  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: localRoot, timeoutMs: 10_000 });
  state.toplevel = top.code === 0 ? top.stdout.trim() : null;
  if (state.toplevel && path.resolve(state.toplevel) !== path.resolve(localRoot)) {
    state.warnings.push(
      `项目目录位于 Git 仓库子目录内（仓库根：${state.toplevel}），提交只会包含项目目录下的变更`,
    );
  }

  const symbolic = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd: localRoot,
    timeoutMs: 10_000,
  });
  if (symbolic.code === 0) state.branch = symbolic.stdout.trim();
  else state.detached = true;

  const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: localRoot, timeoutMs: 10_000 });
  state.head = head.code === 0 ? head.stdout.trim() : null;

  const status = await runGit(['status', '--porcelain'], { cwd: localRoot, timeoutMs: 30_000 });
  if (status.code === 0) {
    const parsed = splitDirty(status.stdout);
    state.dirty = parsed.dirty;
    state.dirtyCount = parsed.dirtyCount;
  }

  if (state.head && state.branch && cfg.remoteUrl) {
    const remote = await runGit(['ls-remote', cfg.remoteUrl, `refs/heads/${cfg.branch}`], {
      cwd: localRoot,
      timeoutMs: 20_000,
    });
    if (remote.code !== 0) {
      state.warnings.push('暂时无法访问中心仓库（检查网络或凭据），推送时会再次尝试');
    } else {
      const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? '';
      const fullHead = await runGit(['rev-parse', 'HEAD'], { cwd: localRoot, timeoutMs: 10_000 });
      const localSha = fullHead.code === 0 ? fullHead.stdout.trim() : '';
      if (!remoteSha) {
        state.ahead = null;
      } else if (localSha && remoteSha === localSha) {
        state.ahead = 0;
        state.behind = 0;
      } else {
        const exists = await runGit(['cat-file', '-e', `${remoteSha}^{commit}`], {
          cwd: localRoot,
          timeoutMs: 10_000,
        });
        if (exists.code === 0) {
          const ahead = await runGit(['rev-list', '--count', `${remoteSha}..HEAD`], {
            cwd: localRoot,
            timeoutMs: 20_000,
          });
          const behind = await runGit(['rev-list', '--count', `HEAD..${remoteSha}`], {
            cwd: localRoot,
            timeoutMs: 20_000,
          });
          state.ahead = ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : null;
          state.behind = behind.code === 0 ? Number(behind.stdout.trim()) || 0 : null;
        } else {
          state.warnings.push('中心仓库包含本地尚未拉取的提交，推送时如果分叉会被拒绝（不会强制推送）');
        }
      }
    }
  }
  return state;
}

function marker(name: string): string {
  return `@@SM_${name}@@`;
}

function stripMarker(line: string, name: string): string {
  return line.slice(marker(name).length);
}

const REMOTE_STATE_STATES = new Set(['missing', 'empty', 'nonempty', 'repo', 'error']);

function parseRemoteState(output: string): GitTargetState {
  const state: GitTargetState = {
    state: 'error',
    branch: null,
    head: null,
    dirty: [],
    dirtyCount: 0,
    reason: null,
  };
  let inDirty = false;
  let gitAvailable = true;
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith(marker('STATE'))) {
      const value = stripMarker(raw, 'STATE').trim();
      state.state = REMOTE_STATE_STATES.has(value) ? (value as GitTargetState['state']) : 'error';
      continue;
    }
    if (raw.startsWith(marker('GIT'))) {
      gitAvailable = stripMarker(raw, 'GIT').trim() === '1';
      continue;
    }
    if (raw.startsWith(marker('BRANCH'))) {
      state.branch = stripMarker(raw, 'BRANCH').trim() || null;
      continue;
    }
    if (raw.startsWith(marker('HEAD'))) {
      state.head = stripMarker(raw, 'HEAD').trim() || null;
      continue;
    }
    if (raw.startsWith(marker('REASON'))) {
      state.reason = stripMarker(raw, 'REASON').trim() || null;
      continue;
    }
    if (raw.startsWith(marker('DIRTY'))) {
      inDirty = true;
      continue;
    }
    if (raw.startsWith(marker('END'))) {
      inDirty = false;
      continue;
    }
    if (inDirty && raw.trim()) {
      state.dirty.push(raw.trimEnd());
    }
  }
  state.dirtyCount = state.dirty.length;
  if (state.state === 'repo' && !gitAvailable) {
    state.reason = '目标机未安装 git';
  }
  return state;
}

async function inspectRemoteTarget(client: Client, dir: string): Promise<GitTargetState> {
  const script = [
    `d=${shq(dir)}`,
    'if [ ! -e "$d" ]; then',
    `  printf '${marker('STATE')}missing\\n'`,
    'elif [ ! -d "$d" ]; then',
    `  printf '${marker('STATE')}error\\n${marker('REASON')}not_a_directory\\n'`,
    'elif [ -d "$d/.git" ]; then',
    `  printf '${marker('STATE')}repo\\n'`,
    '  if command -v git >/dev/null 2>&1; then',
    `    printf '${marker('GIT')}1\\n'`,
    '    b=$(git -C "$d" symbolic-ref --short -q HEAD 2>/dev/null || true)',
    `    printf '${marker('BRANCH')}%s\\n' "$b"`,
    '    h=$(git -C "$d" rev-parse --short HEAD 2>/dev/null || true)',
    `    printf '${marker('HEAD')}%s\\n' "$h"`,
    `    printf '${marker('DIRTY')}\\n'`,
    '    git -C "$d" status --porcelain 2>/dev/null | head -n 200',
    `    printf '${marker('END')}\\n'`,
    '  else',
    `    printf '${marker('GIT')}0\\n${marker('END')}\\n'`,
    '  fi',
    'elif [ -z "$(ls -A "$d" 2>/dev/null)" ]; then',
    `  printf '${marker('STATE')}empty\\n'`,
    'else',
    `  printf '${marker('STATE')}nonempty\\n'`,
    'fi',
  ].join('\n');
  try {
    const result = await runExec(client, `bash -c ${shq(script)}`, {
      timeoutMs: 30_000,
      maxBytes: 512 * 1024,
    });
    if (!result.stdout.includes(marker('STATE'))) {
      return {
        state: 'error',
        branch: null,
        head: null,
        dirty: [],
        dirtyCount: 0,
        reason: tailText(result.stderr || `退出码 ${result.code ?? '未知'}`),
      };
    }
    return parseRemoteState(result.stdout);
  } catch (err) {
    return {
      state: 'error',
      branch: null,
      head: null,
      dirty: [],
      dirtyCount: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function targetStateLabel(state: GitTargetState): string {
  switch (state.state) {
    case 'missing':
      return '目录不存在';
    case 'empty':
      return '目录为空';
    case 'nonempty':
      return '目录非空且不是 Git 仓库';
    case 'repo':
      return `Git 仓库（分支 ${state.branch ?? 'detached'}，${state.head ?? '无提交'}）`;
    default:
      return `读取失败：${state.reason ?? '未知错误'}`;
  }
}

function repoStateFromTarget(target: GitTargetState, warnings: string[] = []): GitRepoState {
  return {
    available: target.state === 'repo',
    isRepo: target.state === 'repo',
    toplevel: null,
    branch: target.branch,
    detached: target.state === 'repo' && !target.branch,
    head: target.head,
    dirty: target.dirty,
    dirtyCount: target.dirtyCount,
    ahead: null,
    behind: null,
    warnings,
  };
}

function requireUsableLocal(state: GitRepoState, localRoot: string): void {
  if (!state.available) {
    throw new ApiError(400, 'GIT_NOT_INSTALLED', '本机未安装 git 或 git 不可用');
  }
  if (!state.isRepo) {
    throw new ApiError(
      400,
      'GIT_LOCAL_NOT_REPO',
      `本地项目目录不是 Git 仓库：${localRoot}\n可在项目目录执行：\n  git init -b main\n  git add -A\n  git commit -m "init"\n  git remote add origin <中心仓库地址>\n（本工具不会代替你执行这些命令）`,
    );
  }
  if (state.detached) {
    throw new ApiError(400, 'GIT_LOCAL_DETACHED', '本地仓库处于 detached HEAD 状态，请先切换回分支再同步');
  }
  if (!state.head) {
    throw new ApiError(400, 'GIT_LOCAL_EMPTY', '本地仓库还没有任何提交，请先完成一次提交');
  }
}

function requireUsableRemoteSource(state: GitRepoState, dir: string, serverName: string | undefined): void {
  if (!state.isRepo) {
    throw new ApiError(
      400,
      'GIT_SOURCE_NOT_REPO',
      `源目标服务器（${serverName ?? '未知'}）的代码目录不是 Git 仓库：${dir}\n请先在该目录初始化仓库并配置中心仓库凭据`,
    );
  }
  if (state.detached) {
    throw new ApiError(400, 'GIT_SOURCE_DETACHED', '源目标服务器的仓库处于 detached HEAD 状态');
  }
  if (!state.head) {
    throw new ApiError(400, 'GIT_SOURCE_EMPTY', '源目标服务器的仓库还没有任何提交');
  }
}

type RemoteStep = {
  client: Client;
  signal?: AbortSignal;
  onLine?: LineSink;
};

async function remoteGit(
  step: RemoteStep,
  command: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runExecStream(step.client, command, {
    timeoutMs,
    maxBytes: 2 * 1024 * 1024,
    onLine: step.onLine,
  });
  if (step.signal?.aborted) throw new SyncAbortedError();
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function commitAndPushRemote(args: {
  client: Client;
  dir: string;
  cfg: GitConfig;
  project: ProjectRow;
  target: TargetRow;
  runId: string;
  emit: Emit;
  signal: AbortSignal;
}): Promise<{ committed: string | null; pushed: boolean; ahead: number | null }> {
  const { client, dir, cfg, project, target, runId, emit, signal } = args;
  const streamLines: LineSink = (line) => emit('info', `git: ${line}`);
  const status = await remoteGit({ client, signal }, `git -C ${shq(dir)} status --porcelain`, 30_000);
  const dirty = splitDirty(status.stdout);
  let committed: string | null = null;
  if (dirty.dirtyCount > 0) {
    if (!cfg.autoCommitOnSource) {
      emit('warn', `源目标工作区有 ${dirty.dirtyCount} 处未提交变更（自动提交已关闭），将按当前 HEAD 推送`);
    } else {
      emit('info', `源目标工作区有 ${dirty.dirtyCount} 处未提交变更，执行 git add -A 与 git commit`);
      const add = await remoteGit({ client, signal, onLine: streamLines }, `git -C ${shq(dir)} add -A`, 60_000);
      if (add.code !== 0) {
        throw new ApiError(400, 'GIT_COMMAND_FAILED', `源目标 git add 失败：\n${tailText(sanitizeGitText(add.stderr || add.stdout, cfg.remoteUrl))}`);
      }
      const message = renderCommitMessage(project, target, cfg);
      const commit = await remoteGit({ client, signal, onLine: streamLines }, `git -C ${shq(dir)} commit -m ${shq(message)}`, 60_000);
      if (commit.code !== 0) {
        throw new ApiError(
          400,
          'GIT_COMMAND_FAILED',
          `源目标 git commit 失败：\n${tailText(sanitizeGitText(commit.stderr || commit.stdout, cfg.remoteUrl))}\n请确认源目标服务器已配置 git 用户（git config user.name / user.email）`,
        );
      }
      const head = await remoteGit({ client, signal }, `git -C ${shq(dir)} rev-parse --short HEAD`, 15_000);
      committed = head.stdout.trim() || null;
      emit('info', `已在源目标服务器提交：${committed ?? '新提交'}（${message}）`);
    }
  } else {
    emit('info', '源目标工作区干净，无需提交');
  }

  setStatus(runId, 'pushing');
  emit('info', `将推送源目标 HEAD 到 ${redactUrl(cfg.remoteUrl)}（分支 ${cfg.branch}）`);
  const push = await remoteGit(
    { client, signal, onLine: streamLines },
    `git -C ${shq(dir)} push ${shq(cfg.remoteUrl)} ${shq(`HEAD:refs/heads/${cfg.branch}`)}`,
    NETWORK_TIMEOUT_MS,
  );
  if (push.code !== 0) throw pushFailure(push, cfg);
  emit('info', '推送完成');
  return { committed, pushed: true, ahead: null };
}

async function commitAndPushLocal(args: {
  localRoot: string;
  cfg: GitConfig;
  project: ProjectRow;
  target: TargetRow;
  state: GitRepoState;
  runId: string;
  emit: Emit;
  signal: AbortSignal;
}): Promise<{ committed: string | null; pushed: boolean; ahead: number | null; clearDirty: boolean }> {
  const { localRoot, cfg, project, target, state, runId, emit, signal } = args;
  let committed: string | null = null;
  let clearDirty = false;

  if (state.dirtyCount > 0) {
    if (!cfg.autoCommitOnSource) {
      emit('warn', `本地有 ${state.dirtyCount} 处未提交变更（自动提交已关闭），将推送当前 HEAD`);
    } else {
      emit('info', `本地有 ${state.dirtyCount} 处未提交变更，执行 git add -A 与 git commit`);
      const add = await runGit(['add', '-A'], {
        cwd: localRoot,
        timeoutMs: 60_000,
        signal,
      });
      if (add.code !== 0) throw localFailure('add -A', add, cfg);
      const message = renderCommitMessage(project, target, cfg);
      const commit = await runGit(['commit', '-m', message], {
        cwd: localRoot,
        timeoutMs: 60_000,
        signal,
      });
      if (commit.code !== 0) {
        throw localFailure(
          'commit',
          commit,
          cfg,
          '请确认本机已配置 git 用户（git config user.name / user.email）',
        );
      }
      const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: localRoot, timeoutMs: 10_000 });
      committed = head.stdout.trim() || null;
      clearDirty = true;
      emit('info', `已提交：${committed ?? '新提交'}（${message}）`);
    }
  } else {
    emit('info', '本地工作区干净，无需提交');
  }

  const ahead =
    committed !== null ? (state.ahead === null ? null : state.ahead + 1) : state.ahead;
  if (ahead === 0) {
    if (state.behind && state.behind > 0) emit('warn', '本地落后于中心仓库，本次跳过推送（目标机会从中心仓库更新）');
    else emit('info', '没有需要推送的新提交，跳过推送');
    return { committed, pushed: false, ahead, clearDirty };
  }

  setStatus(runId, 'pushing');
  emit(
    'info',
    ahead !== null
      ? `将推送 ${ahead} 个本地提交到 ${redactUrl(cfg.remoteUrl)}（分支 ${cfg.branch}）`
      : `将推送当前 HEAD 到 ${redactUrl(cfg.remoteUrl)}（分支 ${cfg.branch}）`,
  );
  const push = await runGit(
    ['push', cfg.remoteUrl, `HEAD:refs/heads/${cfg.branch}`],
    {
      cwd: localRoot,
      timeoutMs: NETWORK_TIMEOUT_MS,
      signal,
      onLine: (line) => emit('info', `git: ${line}`),
    },
  );
  if (push.code !== 0) throw pushFailure(push, cfg);
  emit('info', '推送完成');
  return { committed, pushed: true, ahead, clearDirty };
}

async function updateTargetRepo(args: {
  client: Client;
  target: TargetRow;
  cfg: GitConfig;
  emit: Emit;
  signal: AbortSignal;
}): Promise<{ action: GitTargetAction; state: GitTargetState }> {
  const { client, target, cfg, emit, signal } = args;
  const dir = target.remote_code_dir;
  const step: RemoteStep = {
    client,
    signal,
    onLine: (line) => emit('info', `git: ${line}`),
  };

  const initial = await inspectRemoteTarget(client, dir);
  if (signal.aborted) throw new SyncAbortedError();
  if (initial.state === 'error') {
    throw new ApiError(400, 'GIT_TARGET_ERROR', `无法读取目标机代码目录状态：${initial.reason ?? '未知错误'}`);
  }
  if (initial.state === 'nonempty') {
    throw new ApiError(
      400,
      'GIT_TARGET_NONEMPTY',
      `目标机代码目录非空且不是 Git 仓库：${dir}\n为避免误删，已中止；请改名或清空该目录，或改用 SFTP 同步模式。`,
    );
  }

  if (initial.state === 'missing' || initial.state === 'empty') {
    if (!cfg.cloneIfMissing) {
      throw new ApiError(400, 'GIT_TARGET_MISSING', `目标机代码目录不存在：${dir}，且未开启自动克隆`);
    }
    const parent = path.posix.dirname(dir.replace(/\/+$/, ''));
    emit('info', `目标机目录为空，开始克隆 ${redactUrl(cfg.remoteUrl)}（分支 ${cfg.branch}）…`);
    const mk = await runExec(client, `mkdir -p ${shq(parent)}`, { timeoutMs: 15_000 });
    if (mk.code !== 0) {
      throw new ApiError(400, 'GIT_TARGET_MKDIR_FAILED', `无法创建目标目录的父目录：${tailText(mk.stderr) || parent}`);
    }
    const clone = await remoteGit(
      step,
      `git clone --branch ${shq(cfg.branch)} --single-branch ${shq(cfg.remoteUrl)} ${shq(dir)}`,
      240_000,
    );
    if (clone.code !== 0) {
      throw new ApiError(
        400,
        'GIT_CLONE_FAILED',
        `目标机克隆失败（目标机需要能访问中心仓库并具备凭据）：\n${tailText(sanitizeGitText(clone.stderr || clone.stdout, cfg.remoteUrl))}`,
      );
    }
    const fresh = await inspectRemoteTarget(client, dir);
    emit('info', `目标机已克隆到 ${dir}（HEAD ${fresh.head ?? '未知'}）`);
    return { action: 'cloned', state: fresh };
  }

  if (initial.dirtyCount > 0) {
    throw new ApiError(
      400,
      'GIT_TARGET_DIRTY',
      `目标机工作区有未提交变更（${initial.dirtyCount} 项），为避免覆盖已中止，未对目标机执行任何写操作：\n` +
        `${initial.dirty.slice(0, 10).join('\n')}${initial.dirtyCount > 10 ? `\n… 其余 ${initial.dirtyCount - 10} 项` : ''}\n` +
        '建议：\n1) 在目标机上提交或备份这些变更后重试；\n2) 手工清理工作区后重试；\n3) 需要保留远端改动时改用 SFTP 同步模式。',
    );
  }

  const headBefore = initial.head;
  const fetch = await remoteGit(
    step,
    `git -C ${shq(dir)} fetch ${shq(cfg.remoteUrl)} ${shq(cfg.branch)}`,
    NETWORK_TIMEOUT_MS,
  );
  if (fetch.code !== 0) {
    throw new ApiError(
      400,
      'GIT_FETCH_FAILED',
      `目标机拉取中心仓库失败（目标机需要具备仓库凭据）：\n${tailText(sanitizeGitText(fetch.stderr || fetch.stdout, cfg.remoteUrl))}`,
    );
  }

  if (initial.branch !== cfg.branch) {
    emit('info', `切换目标机仓库分支：${initial.branch ?? 'detached'} → ${cfg.branch}`);
    let checkout = await remoteGit(step, `git -C ${shq(dir)} checkout ${shq(cfg.branch)}`, 60_000);
    if (checkout.code !== 0) {
      checkout = await remoteGit(step, `git -C ${shq(dir)} checkout -B ${shq(cfg.branch)} FETCH_HEAD`, 60_000);
    }
    if (checkout.code !== 0) {
      throw new ApiError(
        400,
        'GIT_CHECKOUT_FAILED',
        `目标机切换分支失败（工作区干净时才会切换）：\n${tailText(sanitizeGitText(checkout.stderr || checkout.stdout, cfg.remoteUrl))}`,
      );
    }
  }

  const merge = await remoteGit(step, `git -C ${shq(dir)} merge --ff-only FETCH_HEAD`, 60_000);
  if (merge.code !== 0) {
    throw new ApiError(
      400,
      'GIT_TARGET_DIVERGED',
      `目标机分支与中心仓库历史分叉，无法快进合并，已中止（目标机工作区未改动）：\n${tailText(sanitizeGitText(merge.stderr || merge.stdout, cfg.remoteUrl))}\n` +
        '建议：\n1) 在目标机上检查分支历史；\n2) 备份后手工重置到中心仓库分支；\n3) 换用 SFTP 同步模式。',
    );
  }

  const fresh = await inspectRemoteTarget(client, dir);
  const action: GitTargetAction =
    fresh.head && fresh.head === headBefore ? 'up_to_date' : 'fast_forward';
  emit('info', action === 'up_to_date' ? '目标机已是最新' : `目标机已更新到 ${fresh.head ?? '新版本'}`);
  return { action, state: fresh };
}

export function startGitRun(target: TargetRow, input: StartSyncInput): SyncRunDTO {
  const project = getProjectRow(target.project_id);
  if (!project) throw notFound('项目');
  const cfg = gitConfigOf(target);
  if (!cfg.remoteUrl) {
    throw new ApiError(400, 'GIT_REMOTE_MISSING', '该目标使用 Git 模式，但尚未配置中心仓库地址');
  }
  if (input.sourceTargetId) {
    throw new ApiError(
      400,
      'GIT_RELAY_UNSUPPORTED',
      'Git 模式统一经中心仓库更新目标机，不支持 A→B 直传参数；A→B 直传请使用 SFTP 中转',
    );
  }
  const dryRun = Boolean(input.dryRun);

  let sourceTarget: TargetRow | undefined;
  if (cfg.sourceKind === 'target') {
    if (!cfg.sourceTargetId) {
      throw new ApiError(400, 'GIT_SOURCE_MISSING', '提交源设为远程服务器时，需要选择一个源目标');
    }
    if (cfg.sourceTargetId === target.id) {
      throw new ApiError(400, 'GIT_SOURCE_SAME_AS_TARGET', '提交源不能与目标相同');
    }
    sourceTarget = getTargetRow(cfg.sourceTargetId);
    if (!sourceTarget) throw notFound('源目标');
    if (sourceTarget.project_id !== project.id) {
      throw new ApiError(400, 'GIT_SOURCE_PROJECT_MISMATCH', '提交源目标必须属于同一个项目');
    }
    if (isTargetBusy(sourceTarget.id)) {
      throw new ApiError(409, 'SOURCE_SYNC_IN_PROGRESS', '源目标正在同步，请等待其完成后再重试');
    }
  } else {
    try {
      if (!fs.statSync(project.local_root).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new ApiError(400, 'LOCAL_ROOT_INVALID', `本地目录不存在或无法访问：${project.local_root}`);
    }
  }

  if (isTargetBusy(target.id)) {
    throw new ApiError(409, 'SYNC_IN_PROGRESS', '该目标已有同步任务在运行，请等待完成或取消');
  }

  const id = randomUUID();
  const source = sourceTarget
    ? {
        label: `${sourceTarget.label || sourceTarget.server_name || '源目标'}（远程提交源）`,
        serverId: sourceTarget.server_id,
        dir: sourceTarget.remote_code_dir,
      }
    : { label: `${project.name}（本地）`, dir: project.local_root };
  const dest = {
    label: target.server_name ?? '远程服务器',
    serverId: target.server_id,
    dir: target.remote_code_dir,
  };
  prepare(
    `INSERT INTO sync_runs
       (id, project_id, target_id, mode, direction, source_json, dest_json, dry_run, status, started_at)
     VALUES (?, ?, ?, 'git', 'local_to_remote', ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    project.id,
    target.id,
    JSON.stringify(source),
    JSON.stringify(dest),
    dryRun ? 1 : 0,
    Date.now(),
  );

  const controller = new AbortController();
  registerActiveRun(id, target.id, controller);
  setImmediate(() => {
    void executeGitRun(id, dryRun, controller).catch((err) => {
      log.error('Git 同步执行异常', {
        runId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
  return getSyncRunDto(id);
}

export async function executeGitRun(
  runId: string,
  dryRun: boolean,
  controller: AbortController,
): Promise<void> {
  const row = getSyncRunRow(runId);
  if (!row) return;
  const finish = createFinisher(runId);
  const output = new OutputTail(runId);
  const startedAtMs = row.started_at;
  let remoteUrl = '';
  const emit: Emit = (level, message) => {
    const clean = remoteUrl ? sanitizeGitText(message, remoteUrl) : message;
    logLine(runId, level, clean);
    output.append(clean);
  };

  try {
    const project = getProjectRow(row.project_id);
    if (!project) throw new ApiError(404, 'PROJECT_MISSING', '项目已被删除');
    const target = row.target_id ? getTargetRow(row.target_id) : undefined;
    if (!target) throw new ApiError(409, 'TARGET_MISSING', '目标已被删除');
    const cfg = gitConfigOf(target);
    remoteUrl = cfg.remoteUrl;
    if (!cfg.remoteUrl) {
      throw new ApiError(400, 'GIT_REMOTE_MISSING', 'Git 模式需要先配置中心仓库地址');
    }

    const warnings: string[] = [];
    setStatus(runId, 'scanning');
    emit('info', `Git 同步：${redactUrl(cfg.remoteUrl)}（分支 ${cfg.branch}）`);

    let localState: GitRepoState | null = null;
    let sourceState: GitRepoState | null = null;
    let sourceTarget: TargetRow | undefined;

    if (cfg.sourceKind === 'target') {
      if (!cfg.sourceTargetId) throw new ApiError(400, 'GIT_SOURCE_MISSING', '未选择提交源目标');
      sourceTarget = getTargetRow(cfg.sourceTargetId);
      if (!sourceTarget) throw new ApiError(409, 'SOURCE_TARGET_MISSING', '提交源目标已被删除');
      if (sourceTarget.project_id !== project.id) {
        throw new ApiError(400, 'GIT_SOURCE_PROJECT_MISMATCH', '提交源目标不属于当前项目');
      }
      const sourceTargetRow = sourceTarget;
      emit(
        'info',
        `提交源：服务器 ${sourceTargetRow.server_name ?? '未知'}（${sourceTargetRow.remote_code_dir}）`,
      );
      sourceState = await withClient(getServerConnectConfig(sourceTargetRow.server_id), async (client) => {
        const targetState = await inspectRemoteTarget(client, sourceTargetRow.remote_code_dir);
        return repoStateFromTarget(
          targetState,
          targetState.state === 'repo' ? [] : [`源目标目录状态：${targetStateLabel(targetState)}`],
        );
      });
      warnings.push(...sourceState.warnings);
      requireUsableRemoteSource(sourceState, sourceTargetRow.remote_code_dir, sourceTargetRow.server_name);
      emit(
        'info',
        `源仓库：分支 ${sourceState.branch ?? 'detached'}，HEAD ${sourceState.head ?? '未知'}，未提交变更 ${sourceState.dirtyCount} 项`,
      );
      // 本地仓库仅用于提示，不影响流程
      try {
        const peek = await inspectLocalRepo(project.local_root, cfg);
        if (peek.isRepo && peek.head && peek.head !== sourceState.head) {
          warnings.push('本地仓库与提交源不同步，同步完成后建议在本地执行 git pull');
        }
      } catch {
        // 提示性检查失败可忽略
      }
    } else {
      emit('info', `提交源：本地项目目录 ${project.local_root}`);
      localState = await inspectLocalRepo(project.local_root, cfg);
      warnings.push(...localState.warnings);
      requireUsableLocal(localState, project.local_root);
      emit(
        'info',
        `本地仓库：分支 ${localState.branch ?? 'detached'}，HEAD ${localState.head ?? '未知'}，` +
          `未提交变更 ${localState.dirtyCount} 项` +
          (localState.ahead !== null ? `，待推送 ${localState.ahead} 个提交` : ''),
      );
    }

    let targetState = await withClient(getServerConnectConfig(target.server_id), (client) =>
      inspectRemoteTarget(client, target.remote_code_dir),
    );
    emit('info', `目标机：${targetStateLabel(targetState)}`);
    if (targetState.state === 'nonempty') {
      warnings.push('目标机目录非空且不是 Git 仓库，真实同步会中止');
    }
    if (targetState.state === 'repo' && targetState.dirtyCount > 0) {
      warnings.push(`目标机工作区有 ${targetState.dirtyCount} 项未提交变更，真实同步会中止`);
    }

    let committed: string | null = null;
    let pushed = false;
    let ahead = localState?.ahead ?? null;
    let targetAction: GitTargetAction | null = null;

    if (dryRun) {
      targetAction = 'reported';
      emit('info', '差异检查完成（只读，不会提交、推送或更新目标机）');
    } else {
      if (cfg.sourceKind === 'target' && sourceTarget) {
        const remoteSource = sourceTarget;
        const result = await withClient(getServerConnectConfig(remoteSource.server_id), (client) =>
          commitAndPushRemote({
            client,
            dir: remoteSource.remote_code_dir,
            cfg,
            project,
            target,
            runId,
            emit,
            signal: controller.signal,
          }),
        );
        committed = result.committed;
        pushed = result.pushed;
        ahead = result.ahead;
        if (controller.signal.aborted) throw new SyncAbortedError();
      } else if (localState) {
        const result = await commitAndPushLocal({
          localRoot: project.local_root,
          cfg,
          project,
          target,
          state: localState,
          runId,
          emit,
          signal: controller.signal,
        });
        committed = result.committed;
        pushed = result.pushed;
        ahead = result.ahead;
        if (result.clearDirty) {
          localState = { ...localState, dirty: [], dirtyCount: 0 };
        }
      }

      setStatus(runId, 'transferring');
      emit('info', '开始更新目标机…');
      const updated = await withClient(getServerConnectConfig(target.server_id), (client) =>
        updateTargetRepo({ client, target, cfg, emit, signal: controller.signal }),
      );
      targetAction = updated.action;
      targetState = updated.state;
    }

    const summary: GitRunSummary = {
      remoteUrl: redactUrl(cfg.remoteUrl),
      branch: cfg.branch,
      sourceKind: cfg.sourceKind,
      committed,
      pushed,
      ahead,
      targetAction,
      local: localState,
      source: sourceState,
      target: targetState,
      warnings,
    };
    finish('done', {
      stats: {
        mode: 'git',
        git: summary,
        durationMs: Date.now() - startedAtMs,
      },
    });
  } catch (err) {
    if (controller.signal.aborted || err instanceof SyncAbortedError) {
      emit('warn', 'Git 同步已取消');
      finish('canceled', { error: '已取消' });
    } else {
      const raw = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      const message = remoteUrl ? sanitizeGitText(raw, remoteUrl) : raw;
      log.warn('Git 同步失败', { runId, message });
      emit('error', `Git 同步失败：${message}`);
      finish('failed', { error: message });
    }
  } finally {
    output.flush();
  }
}

export async function detectGitTarget(targetId: string): Promise<GitDetectResult> {
  const target = getTargetRow(targetId);
  if (!target) throw notFound('目标');
  const project = getProjectRow(target.project_id);
  if (!project) throw notFound('项目');
  const cfg = gitConfigOf(target);
  const result: GitDetectResult = {
    ok: false,
    remoteUrl: redactUrl(cfg.remoteUrl),
    branch: cfg.branch,
    sourceKind: cfg.sourceKind,
    local: null,
    source: null,
    target: null,
    warnings: [],
    error: null,
  };
  if (!cfg.remoteUrl) {
    result.warnings.push('尚未配置中心仓库地址（Git 同步前必须填写）');
  }

  if (cfg.sourceKind === 'target') {
    if (!cfg.sourceTargetId) {
      result.error = '未选择提交源目标';
    } else {
      const sourceTarget = getTargetRow(cfg.sourceTargetId);
      if (!sourceTarget) result.error = '提交源目标已被删除';
      else if (sourceTarget.project_id !== project.id) result.error = '提交源目标不属于当前项目';
      else {
        try {
          const source = await withClient(getServerConnectConfig(sourceTarget.server_id), async (client) => {
            const state = await inspectRemoteTarget(client, sourceTarget.remote_code_dir);
            return repoStateFromTarget(
              state,
              state.state === 'repo' ? [] : [`源目标目录状态：${targetStateLabel(state)}`],
            );
          });
          result.source = source;
          result.ok = source.isRepo;
          if (!source.isRepo) result.error = '提交源目标不是 Git 仓库';
          else if (source.detached) result.error = '提交源目标处于 detached HEAD 状态';
          else if (!source.head) result.error = '提交源目标还没有任何提交';
          result.warnings.push(...source.warnings);
        } catch (err) {
          result.error = `读取提交源失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  } else {
    try {
      const local = await inspectLocalRepo(project.local_root, cfg);
      result.local = local;
      result.ok = local.isRepo;
      result.warnings.push(...local.warnings);
      if (!local.available) result.error = '本机未安装 git';
      else if (!local.isRepo) result.error = '本地项目目录不是 Git 仓库';
      else if (local.detached) result.error = '本地仓库处于 detached HEAD 状态';
      else if (!local.head) result.error = '本地仓库还没有任何提交';
    } catch (err) {
      result.error = `读取本地仓库失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  try {
    result.target = await withClient(getServerConnectConfig(target.server_id), (client) =>
      inspectRemoteTarget(client, target.remote_code_dir),
    );
    if (result.target.state === 'nonempty') {
      result.warnings.push('目标机代码目录非空且不是 Git 仓库，同步会中止（不会删除目录）');
    }
    if (result.target.state === 'error') {
      result.warnings.push(`目标机目录状态读取失败：${result.target.reason ?? '未知错误'}`);
    }
  } catch (err) {
    result.target = {
      state: 'error',
      branch: null,
      head: null,
      dirty: [],
      dirtyCount: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
    result.warnings.push('无法连接目标机读取目录状态');
  }
  return result;
}