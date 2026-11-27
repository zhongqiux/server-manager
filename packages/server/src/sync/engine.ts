import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Caps,
  HardwareSnapshot,
  SyncMode,
  SyncPlan,
  SyncProgress,
  SyncRunDTO,
  SyncRunStatus,
  TargetSyncConfig,
} from '@sm/shared';
import { shq } from '@sm/shared';
import { RELAY_DIR, SFTP_FILE_CONCURRENCY } from '../config.ts';
import { prepare } from '../db/index.ts';
import { ApiError, notFound } from '../errors.ts';
import { createLogger } from '../logger.ts';
import { getProjectRow } from '../services/projects.ts';
import { getServerConnectConfig, getServerRow, type ServerRow } from '../services/servers.ts';
import { getSyncRunDto, getSyncRunRow, isTerminalStatus, updateSyncRun } from '../services/sync.ts';
import { getTargetRow, type TargetRow } from '../services/targets.ts';
import { runExec } from '../transport/ssh/exec.ts';
import { withClient } from '../transport/ssh/pool.ts';
import { openSftp, sftpMkdirp, sftpStat } from '../transport/ssh/sftp.ts';
import { diffLocalToRemote } from './diff.ts';
import { startGitRun } from './git-engine.ts';
import { buildIgnoreMatcher, type IgnoreMatcher } from './ignore.ts';
import { scanLocalFiles, type LocalFile } from './localscan.ts';
import { readRemoteManifest, type RemoteEntry } from './manifest.ts';
import { planOrphans, relativeDataDir, validateMirrorRoot, type OrphanPlan } from './mirror.ts';
import {
  activeByTarget,
  activeRuns,
  createFinisher,
  logLine,
  publish,
  publishSyncSummary,
  registerActiveRun,
  setStatus,
  type StartSyncInput,
} from './run-utils.ts';
import {
  deleteRemoteActions,
  downloadRemoteActions,
  SyncAbortedError,
  uploadActions,
} from './transfer.ts';

const log = createLogger('sync');
const PLAN_ACTION_LIMIT = 500;
const PROGRESS_THROTTLE_MS = 250;
const RELAY_CONCURRENCY = 2;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function mirrorNameOf(target: TargetRow): string {
  return target.label || target.server_name || target.id;
}

function ensureMirrorConfirmation(
  target: TargetRow,
  syncConfig: TargetSyncConfig,
  dryRun: boolean,
  confirmTargetName?: string,
): void {
  if (!syncConfig.mirrorDelete || dryRun) return;
  const expected = mirrorNameOf(target);
  if (confirmTargetName !== expected) {
    throw new ApiError(
      400,
      'MIRROR_DELETE_CONFIRM_REQUIRED',
      `镜像删除已开启，请输入目标名「${expected}」以确认本次操作`,
    );
  }
}

function homeOf(serverRow: ServerRow | undefined): string | null {
  const hardware = parseJson<HardwareSnapshot | null>(serverRow?.hw_json, null);
  return hardware?.home ?? null;
}

async function resolveRemoteDir(client: Parameters<typeof runExec>[0], dir: string): Promise<string | null> {
  const result = await runExec(client, `cd -- ${shq(dir)} 2>/dev/null && pwd -P`, {
    timeoutMs: 8000,
    maxBytes: 8192,
  });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function createProgressReporter(runId: string, filesTotal: number, bytesTotal: number) {
  const startedAt = Date.now();
  let filesDone = 0;
  let bytesDone = 0;
  let lastEmit = 0;
  const emit = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    const elapsedMs = Math.max(1, now - startedAt);
    const rateBps = (bytesDone / elapsedMs) * 1000;
    const remainingBytes = Math.max(0, bytesTotal - bytesDone);
    const progress: SyncProgress = {
      phase: 'transferring',
      filesDone,
      filesTotal,
      bytesDone,
      bytesTotal,
      rateBps,
      etaMs: rateBps > 1 ? Math.round((remainingBytes / rateBps) * 1000) : null,
    };
    publish(runId, { type: 'progress', runId, ...progress });
  };
  return {
    emit,
    fileDone: (size: number): void => {
      filesDone += 1;
      bytesDone += size;
      emit(false);
    },
  };
}

function mirrorWarnings(
  enabled: boolean,
  dryRun: boolean,
  orphanPlan: OrphanPlan | null,
): string[] {
  if (!enabled) return [];
  const warnings = [
    '镜像删除已开启：远端代码目录内多余的文件会被删除（.git、数据目录、忽略规则与保护规则命中的文件除外）',
  ];
  if (orphanPlan && orphanPlan.protectedSkipped > 0) {
    warnings.push(
      `已保护 ${orphanPlan.protectedSkipped} 个远端文件（.git、数据目录、忽略规则或保护规则）`,
    );
  }
  if (dryRun && orphanPlan && orphanPlan.actions.length > 0) {
    warnings.push('本次是差异检查，不会删除任何远端文件');
  }
  return warnings;
}

export function startSyncRun(input: StartSyncInput): SyncRunDTO {
  const target = getTargetRow(input.targetId);
  if (!target) throw notFound('目标');
  if (target.sync_mode === 'git') {
    return startGitRun(target, input);
  }
  if (target.sync_mode !== 'sftp') {
    throw new ApiError(400, 'SYNC_MODE_UNSUPPORTED', `不支持的同步模式：${target.sync_mode}`);
  }
  const project = getProjectRow(target.project_id);
  if (!project) throw notFound('项目');
  const dryRun = Boolean(input.dryRun);
  const destSyncConfig = parseJson<TargetSyncConfig>(target.sync_config_json, {});
  ensureMirrorConfirmation(target, destSyncConfig, dryRun, input.confirmTargetName);

  let sourceTarget: TargetRow | undefined;
  if (input.sourceTargetId) {
    if (input.sourceTargetId === target.id) {
      throw new ApiError(400, 'RELAY_SAME_TARGET', '中转源与目标不能是同一个目标');
    }
    sourceTarget = getTargetRow(input.sourceTargetId);
    if (!sourceTarget) throw notFound('源目标');
    if (sourceTarget.project_id !== project.id) {
      throw new ApiError(400, 'RELAY_PROJECT_MISMATCH', '中转源与目标必须属于同一个项目');
    }
    if (sourceTarget.sync_mode !== 'sftp') {
      throw new ApiError(400, 'SYNC_MODE_UNSUPPORTED', '中转源目标必须使用 SFTP 同步模式');
    }
    if (activeByTarget.has(sourceTarget.id)) {
      throw new ApiError(409, 'SOURCE_SYNC_IN_PROGRESS', '源目标正在同步，请等待其完成后再中转');
    }
  } else {
    try {
      if (!fs.statSync(project.local_root).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new ApiError(400, 'LOCAL_ROOT_INVALID', `本地目录不存在或无法访问：${project.local_root}`);
    }
  }

  if (activeByTarget.has(target.id)) {
    throw new ApiError(409, 'SYNC_IN_PROGRESS', '该目标已有同步任务在运行，请等待完成或取消');
  }

  const id = randomUUID();
  const direction = sourceTarget ? 'target_to_target' : 'local_to_remote';
  const source = sourceTarget
    ? {
        label: `${sourceTarget.label || sourceTarget.server_name || '源目标'}（远程）`,
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
     VALUES (?, ?, ?, 'sftp', ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    project.id,
    target.id,
    direction,
    JSON.stringify(source),
    JSON.stringify(dest),
    dryRun ? 1 : 0,
    Date.now(),
  );

  const controller = new AbortController();
  registerActiveRun(id, target.id, controller);
  setImmediate(() => {
    const execution = sourceTarget
      ? executeRelayRun(id, sourceTarget.id, dryRun, controller)
      : executeLocalRun(id, dryRun, controller);
    void execution.catch((err) => {
      log.error('同步执行异常', { runId: id, message: err instanceof Error ? err.message : String(err) });
    });
  });
  return getSyncRunDto(id);
}

export function cancelSyncRun(id: string): SyncRunDTO {
  const row = getSyncRunRow(id);
  if (!row) throw notFound('同步记录');
  if (isTerminalStatus(row.status as SyncRunStatus)) {
    throw new ApiError(409, 'SYNC_NOT_RUNNING', '该同步已结束，无法取消');
  }
  const active = activeRuns.get(id);
  if (active) {
    active.controller.abort();
  } else {
    updateSyncRun(id, {
      status: 'canceled',
      error: '已取消',
      statsJson: row.stats_json,
      finishedAt: Date.now(),
    });
    publish(id, { type: 'done', runId: id, status: 'canceled', counts: null, error: '已取消' });
    publishSyncSummary(id);
  }
  return getSyncRunDto(id);
}

async function executeLocalRun(runId: string, dryRun: boolean, controller: AbortController): Promise<void> {
  const row = getSyncRunRow(runId);
  const active = activeRuns.get(runId);
  if (!row || !active) return;

  const finish = createFinisher(runId);
  const startedAtMs = row.started_at;

  try {
    const project = getProjectRow(row.project_id);
    if (!project) throw new ApiError(404, 'PROJECT_MISSING', '项目已被删除');
    const target = row.target_id ? getTargetRow(row.target_id) : undefined;
    if (!target) throw new ApiError(409, 'TARGET_MISSING', '目标已被删除');

    setStatus(runId, 'scanning');
    logLine(runId, 'info', '扫描本地文件…');
    const syncConfig = parseJson<TargetSyncConfig>(target.sync_config_json, {});
    const dataDirRel = relativeDataDir(target.remote_code_dir, target.data_dir);
    const targetExtra = [...(syncConfig.extraIgnores ?? [])];
    if (dataDirRel) targetExtra.push(`/${dataDirRel}/`);
    const matcher = buildIgnoreMatcher({
      projectExtra: parseJson<string[]>(project.ignore_extra_json, []),
      targetExtra,
    });
    const scan = await scanLocalFiles(project.local_root, matcher);
    if (controller.signal.aborted) throw new SyncAbortedError();

    const warnings: string[] = [];
    if (scan.truncated) warnings.push('本地文件数量超过上限（50000），本次只处理已扫描到的文件');
    if (scan.skippedSymlinks > 0) warnings.push(`已跳过 ${scan.skippedSymlinks} 个符号链接`);
    if (dataDirRel) {
      warnings.push(`数据目录位于远程代码目录内（${dataDirRel}/）：已从本地扫描与远端清单中排除`);
    }
    logLine(
      runId,
      'info',
      `本地扫描完成：${scan.files.length} 个文件，${scan.bytes} 字节，忽略 ${scan.ignoredEntries} 项`,
    );

    const serverRow = getServerRow(target.server_id);
    const homeDir = homeOf(serverRow);
    const caps = parseJson<Caps>(serverRow?.caps_json, {});
    const connectConfig = getServerConnectConfig(target.server_id);

    const outcome: {
      plan: SyncPlan | null;
      transfer: { files: number; bytes: number } | null;
      deleted: { files: number; bytes: number } | null;
    } = { plan: null, transfer: null, deleted: null };

    await withClient(connectConfig, async (client) => {
      const sftp = await openSftp(client);
      if (syncConfig.mirrorDelete) {
        validateMirrorRoot(target.remote_code_dir, homeDir);
      }
      const dirExists = Boolean(await sftpStat(sftp, target.remote_code_dir));
      if (syncConfig.mirrorDelete && dirExists) {
        const resolved = await resolveRemoteDir(client, target.remote_code_dir);
        if (resolved) validateMirrorRoot(resolved, homeDir);
      }
      let remoteFiles = new Map<string, RemoteEntry>();
      if (dirExists) {
        const manifest = await readRemoteManifest({
          client,
          sftp,
          caps,
          dir: target.remote_code_dir,
          matcher,
          dataDirRel,
        });
        remoteFiles = manifest.files;
        warnings.push(...manifest.warnings);
        logLine(
          runId,
          'info',
          `远端清单：${remoteFiles.size} 个文件（${manifest.method === 'find' ? 'GNU find' : 'SFTP 遍历'}${
            manifest.skippedIgnored > 0 ? `，已跳过 ${manifest.skippedIgnored} 个忽略项` : ''
          }）`,
        );
      } else if (dryRun) {
        warnings.push('远端代码目录尚不存在，真实同步时会自动创建');
      } else {
        await sftpMkdirp(sftp, target.remote_code_dir);
        logLine(runId, 'info', `远端目录不存在，已创建 ${target.remote_code_dir}`);
      }
      if (controller.signal.aborted) throw new SyncAbortedError();

      const diff = diffLocalToRemote(scan.files, remoteFiles, {
        sizeOnly: syncConfig.sizeOnly ?? false,
      });
      diff.counts.ignored = scan.ignoredEntries;
      diff.counts.skippedSymlinks = scan.skippedSymlinks;

      let orphanPlan: OrphanPlan | null = null;
      if (syncConfig.mirrorDelete) {
        orphanPlan = planOrphans({
          localRels: new Set(scan.files.map((file) => file.rel)),
          remoteFiles,
          isIgnored: (rel) => matcher.isIgnored(rel),
          dataDirRel,
          protectGlobs: syncConfig.protectGlobs,
        });
        diff.counts.delete = orphanPlan.actions.length;
        diff.counts.protectedSkipped = orphanPlan.protectedSkipped;
        warnings.push(...mirrorWarnings(true, dryRun, orphanPlan));
      }

      const source = parseJson(row.source_json, { label: project.name, dir: project.local_root });
      const dest = parseJson(row.dest_json, {
        label: serverRow?.name ?? '远程服务器',
        serverId: target.server_id,
        dir: target.remote_code_dir,
      });
      const actions = orphanPlan ? [...diff.actions, ...orphanPlan.actions] : diff.actions;
      outcome.plan = {
        runId,
        mode: 'sftp',
        direction: 'local_to_remote',
        source,
        dest,
        counts: diff.counts,
        bytes: {
          upload: diff.uploadBytes,
          delete: orphanPlan?.deleteBytes ?? 0,
          totalLocal: scan.bytes,
        },
        actions: actions.slice(0, PLAN_ACTION_LIMIT),
        truncated: actions.length > PLAN_ACTION_LIMIT,
        warnings,
        ignoreSample: scan.ignoredSample,
      };
      updateSyncRun(runId, { planJson: JSON.stringify(outcome.plan) });
      publish(runId, { type: 'plan', runId, plan: outcome.plan });
      logLine(
        runId,
        'info',
        `差异分析：新增 ${diff.counts.add}，更新 ${diff.counts.updateSize + diff.counts.updateMtime}，删除 ${diff.counts.delete}，未变 ${diff.counts.same}`,
      );

      if (dryRun) return;

      if (diff.actions.length > 0) {
        setStatus(runId, 'transferring');
        const progress = createProgressReporter(runId, diff.actions.length, diff.uploadBytes);
        progress.emit(true);
        outcome.transfer = await uploadActions({
          sftp,
          localRoot: project.local_root,
          remoteRoot: target.remote_code_dir,
          actions: diff.actions,
          execBitPolicy: project.exec_bit_policy === 'all755' ? 'all755' : 'auto',
          preserveMode: syncConfig.preserveMode ?? true,
          concurrency: SFTP_FILE_CONCURRENCY,
          signal: controller.signal,
          onFileDone: (action) => progress.fileDone(action.size),
        });
        progress.emit(true);
        logLine(
          runId,
          'info',
          `上传完成：${outcome.transfer.files} 个文件，${outcome.transfer.bytes} 字节`,
        );
      } else {
        logLine(runId, 'info', '没有需要上传的文件');
      }

      if (orphanPlan && orphanPlan.actions.length > 0) {
        setStatus(runId, 'deleting');
        logLine(runId, 'warn', `开始删除 ${orphanPlan.actions.length} 个远端多余文件…`);
        outcome.deleted = await deleteRemoteActions({
          sftp,
          remoteRoot: target.remote_code_dir,
          actions: orphanPlan.actions,
          concurrency: SFTP_FILE_CONCURRENCY,
          signal: controller.signal,
        });
        logLine(
          runId,
          'info',
          `删除完成：${outcome.deleted.files} 个文件，${outcome.deleted.bytes} 字节`,
        );
      }
    });

    const stats = {
      counts: outcome.plan?.counts ?? null,
      bytes: outcome.plan?.bytes ?? null,
      filesUploaded: outcome.transfer?.files ?? 0,
      uploadedBytes: outcome.transfer?.bytes ?? 0,
      filesDeleted: outcome.deleted?.files ?? 0,
      deletedBytes: outcome.deleted?.bytes ?? 0,
      durationMs: Date.now() - startedAtMs,
    };
    finish('done', { stats });
  } catch (err) {
    if (controller.signal.aborted || err instanceof SyncAbortedError) {
      logLine(runId, 'warn', '同步已取消');
      finish('canceled', { error: '已取消' });
      return;
    }
    const message =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    log.warn('同步失败', { runId, message });
    logLine(runId, 'error', `同步失败：${message}`);
    finish('failed', { error: message });
  }
}

async function readTargetManifest(
  target: TargetRow,
  options: {
    dryRun: boolean;
    mirrorDelete: boolean;
    homeDir: string | null;
    matcher: IgnoreMatcher;
    dataDirRel: string | null;
  },
): Promise<{ files: Map<string, RemoteEntry>; warnings: string[]; exists: boolean }> {
  const serverRow = getServerRow(target.server_id);
  const caps = parseJson<Caps>(serverRow?.caps_json, {});
  const holder: { value: { files: Map<string, RemoteEntry>; warnings: string[]; exists: boolean } | null } = {
    value: null,
  };
  await withClient(getServerConnectConfig(target.server_id), async (client) => {
    const sftp = await openSftp(client);
    if (options.mirrorDelete) validateMirrorRoot(target.remote_code_dir, options.homeDir);
    const exists = Boolean(await sftpStat(sftp, target.remote_code_dir));
    if (!exists) {
      const warnings = options.dryRun ? ['远端代码目录尚不存在，真实同步时会自动创建'] : [];
      if (!options.dryRun) {
        await sftpMkdirp(sftp, target.remote_code_dir);
      }
      holder.value = { files: new Map(), warnings, exists: false };
      return;
    }
    if (options.mirrorDelete) {
      const resolved = await resolveRemoteDir(client, target.remote_code_dir);
      if (resolved) validateMirrorRoot(resolved, options.homeDir);
    }
    const manifest = await readRemoteManifest({
      client,
      sftp,
      caps,
      dir: target.remote_code_dir,
      matcher: options.matcher,
      dataDirRel: options.dataDirRel,
    });
    holder.value = { files: manifest.files, warnings: manifest.warnings, exists: true };
  });
  if (!holder.value) throw new Error(`${serverRow?.name ?? '服务器'} 清单读取失败`);
  return holder.value;
}

async function executeRelayRun(
  runId: string,
  sourceTargetId: string,
  dryRun: boolean,
  controller: AbortController,
): Promise<void> {
  const row = getSyncRunRow(runId);
  const active = activeRuns.get(runId);
  if (!row || !active) return;

  const finish = createFinisher(runId);
  const startedAtMs = row.started_at;

  try {
    const project = getProjectRow(row.project_id);
    if (!project) throw new ApiError(404, 'PROJECT_MISSING', '项目已被删除');
    const destTarget = row.target_id ? getTargetRow(row.target_id) : undefined;
    if (!destTarget) throw new ApiError(409, 'TARGET_MISSING', '目标已被删除');
    const sourceTarget = getTargetRow(sourceTargetId);
    if (!sourceTarget) throw new ApiError(409, 'SOURCE_TARGET_MISSING', '中转源目标已被删除');

    setStatus(runId, 'scanning');
    logLine(
      runId,
      'info',
      `读取源端 ${sourceTarget.server_name ?? '源服务器'} 与目标端清单…`,
    );
    const sourceConfig = parseJson<TargetSyncConfig>(sourceTarget.sync_config_json, {});
    const destConfig = parseJson<TargetSyncConfig>(destTarget.sync_config_json, {});
    const matcher = buildIgnoreMatcher({
      projectExtra: parseJson<string[]>(project.ignore_extra_json, []),
      targetExtra: [...(sourceConfig.extraIgnores ?? []), ...(destConfig.extraIgnores ?? [])],
    });
    const sourceDataRel = relativeDataDir(sourceTarget.remote_code_dir, sourceTarget.data_dir);
    const destDataRel = relativeDataDir(destTarget.remote_code_dir, destTarget.data_dir);
    const destHome = homeOf(getServerRow(destTarget.server_id));

    const [sourceManifest, destManifest] = await Promise.all([
      withClient(getServerConnectConfig(sourceTarget.server_id), async (client) => {
        const sftp = await openSftp(client);
        const exists = Boolean(await sftpStat(sftp, sourceTarget.remote_code_dir));
        if (!exists) {
          throw new ApiError(
            400,
            'RELAY_SOURCE_MISSING',
            `源端远程代码目录不存在：${sourceTarget.remote_code_dir}，请先同步代码到该目标`,
          );
        }
        return readRemoteManifest({
          client,
          sftp,
          caps: parseJson<Caps>(getServerRow(sourceTarget.server_id)?.caps_json, {}),
          dir: sourceTarget.remote_code_dir,
          matcher,
          dataDirRel: sourceDataRel,
        });
      }),
      readTargetManifest(destTarget, {
        dryRun,
        mirrorDelete: Boolean(destConfig.mirrorDelete),
        homeDir: destHome,
        matcher,
        dataDirRel: destDataRel,
      }),
    ]);
    if (controller.signal.aborted) throw new SyncAbortedError();

    const warnings: string[] = [...destManifest.warnings];
    if (sourceDataRel) {
      warnings.push(`源端数据目录位于源代码目录内（${sourceDataRel}/）：已从清单中排除`);
    }
    if (destDataRel) {
      warnings.push(`目标端数据目录位于代码目录内（${destDataRel}/）：已从清单中排除`);
    }
    logLine(
      runId,
      'info',
      `源端清单：${sourceManifest.files.size} 个文件（${sourceManifest.method === 'find' ? 'GNU find' : 'SFTP 遍历'}${
        sourceManifest.skippedIgnored > 0 ? `，已跳过 ${sourceManifest.skippedIgnored} 个忽略项` : ''
      }）`,
    );

    const sourceFiles: LocalFile[] = [...sourceManifest.files].map(([rel, entry]) => ({
      rel,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      mode: 0o100644,
    }));
    const filtered = sourceManifest.skippedIgnored;
    if (filtered > 0) {
      warnings.push(`已从源端清单过滤 ${filtered} 个文件（.git / 数据目录 / 忽略规则）`);
    }
    logLine(runId, 'info', `中转待比较文件：${sourceFiles.length} 个（过滤 ${filtered} 个）`);

    const diff = diffLocalToRemote(sourceFiles, destManifest.files, {
      sizeOnly: destConfig.sizeOnly ?? false,
    });
    diff.counts.ignored = filtered;

    let orphanPlan: OrphanPlan | null = null;
    if (destConfig.mirrorDelete) {
      orphanPlan = planOrphans({
        localRels: new Set(sourceFiles.map((file) => file.rel)),
        remoteFiles: destManifest.files,
        isIgnored: (rel) => matcher.isIgnored(rel),
        dataDirRel: destDataRel,
        protectGlobs: destConfig.protectGlobs,
      });
      diff.counts.delete = orphanPlan.actions.length;
      diff.counts.protectedSkipped = orphanPlan.protectedSkipped;
      warnings.push(...mirrorWarnings(true, dryRun, orphanPlan));
    }

    const source = parseJson(row.source_json, {
      label: sourceTarget.server_name ?? '源服务器',
      dir: sourceTarget.remote_code_dir,
    });
    const dest = parseJson(row.dest_json, {
      label: destTarget.server_name ?? '目标服务器',
      dir: destTarget.remote_code_dir,
    });
    const actions = orphanPlan ? [...diff.actions, ...orphanPlan.actions] : diff.actions;
    const totalSourceBytes = sourceFiles.reduce((sum, file) => sum + file.size, 0);
    const outcome: {
      plan: SyncPlan | null;
      transfer: { files: number; bytes: number } | null;
      deleted: { files: number; bytes: number } | null;
    } = { plan: null, transfer: null, deleted: null };

    outcome.plan = {
      runId,
      mode: 'sftp',
      direction: 'target_to_target',
      source,
      dest,
      counts: diff.counts,
      bytes: {
        upload: diff.uploadBytes,
        delete: orphanPlan?.deleteBytes ?? 0,
        totalLocal: totalSourceBytes,
      },
      actions: actions.slice(0, PLAN_ACTION_LIMIT),
      truncated: actions.length > PLAN_ACTION_LIMIT,
      warnings,
      ignoreSample: [],
    };
    updateSyncRun(runId, { planJson: JSON.stringify(outcome.plan) });
    publish(runId, { type: 'plan', runId, plan: outcome.plan });
    logLine(
      runId,
      'info',
      `差异分析：新增 ${diff.counts.add}，更新 ${diff.counts.updateSize + diff.counts.updateMtime}，删除 ${diff.counts.delete}，未变 ${diff.counts.same}`,
    );

    if (dryRun) {
      finish('done', {
        stats: {
          counts: outcome.plan.counts,
          bytes: outcome.plan.bytes,
          filesUploaded: 0,
          uploadedBytes: 0,
          filesDeleted: 0,
          deletedBytes: 0,
          durationMs: Date.now() - startedAtMs,
        },
      });
      return;
    }

    const relayDir = path.join(RELAY_DIR, runId);
    fs.rmSync(relayDir, { recursive: true, force: true });
    try {
      if (diff.actions.length > 0) {
        setStatus(runId, 'transferring');
        logLine(runId, 'info', `从源端下载 ${diff.actions.length} 个文件到中转区…`);
        const download = await withClient(
          getServerConnectConfig(sourceTarget.server_id),
          async (client) => {
            const sftp = await openSftp(client);
            return downloadRemoteActions({
              sftp,
              remoteRoot: sourceTarget.remote_code_dir,
              localRoot: relayDir,
              actions: diff.actions,
              concurrency: RELAY_CONCURRENCY,
              signal: controller.signal,
            });
          },
        );
        logLine(runId, 'info', `源端下载完成：${download.files} 个文件，${download.bytes} 字节`);

        const progress = createProgressReporter(runId, diff.actions.length, diff.uploadBytes);
        progress.emit(true);
        await withClient(getServerConnectConfig(destTarget.server_id), async (client) => {
          const sftp = await openSftp(client);
          outcome.transfer = await uploadActions({
            sftp,
            localRoot: relayDir,
            remoteRoot: destTarget.remote_code_dir,
            actions: diff.actions,
            execBitPolicy: project.exec_bit_policy === 'all755' ? 'all755' : 'auto',
            preserveMode: destConfig.preserveMode ?? true,
            concurrency: SFTP_FILE_CONCURRENCY,
            signal: controller.signal,
            onFileDone: (action) => progress.fileDone(action.size),
          });
          progress.emit(true);
          logLine(
            runId,
            'info',
            `目标端上传完成：${outcome.transfer.files} 个文件，${outcome.transfer.bytes} 字节`,
          );

          if (orphanPlan && orphanPlan.actions.length > 0) {
            setStatus(runId, 'deleting');
            logLine(runId, 'warn', `开始删除目标端 ${orphanPlan.actions.length} 个多余文件…`);
            outcome.deleted = await deleteRemoteActions({
              sftp,
              remoteRoot: destTarget.remote_code_dir,
              actions: orphanPlan.actions,
              concurrency: SFTP_FILE_CONCURRENCY,
              signal: controller.signal,
            });
          }
        });
      } else if (orphanPlan && orphanPlan.actions.length > 0) {
        await withClient(getServerConnectConfig(destTarget.server_id), async (client) => {
          const sftp = await openSftp(client);
          setStatus(runId, 'deleting');
          logLine(runId, 'warn', `开始删除目标端 ${orphanPlan.actions.length} 个多余文件…`);
          outcome.deleted = await deleteRemoteActions({
            sftp,
            remoteRoot: destTarget.remote_code_dir,
            actions: orphanPlan.actions,
            concurrency: SFTP_FILE_CONCURRENCY,
            signal: controller.signal,
          });
        });
      } else {
        logLine(runId, 'info', '源端与目标端一致，无需传输');
      }
    } finally {
      fs.rmSync(relayDir, { recursive: true, force: true });
    }

    finish('done', {
      stats: {
        counts: outcome.plan.counts,
        bytes: outcome.plan.bytes,
        filesUploaded: outcome.transfer?.files ?? 0,
        uploadedBytes: outcome.transfer?.bytes ?? 0,
        filesDeleted: outcome.deleted?.files ?? 0,
        deletedBytes: outcome.deleted?.bytes ?? 0,
        mode: 'relay',
        durationMs: Date.now() - startedAtMs,
      },
    });
  } catch (err) {
    if (controller.signal.aborted || err instanceof SyncAbortedError) {
      logLine(runId, 'warn', '同步已取消');
      finish('canceled', { error: '已取消' });
      return;
    }
    const message =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    log.warn('中转同步失败', { runId, message });
    logLine(runId, 'error', `中转同步失败：${message}`);
    finish('failed', { error: message });
  }
}