import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  AuthType,
  Caps,
  HardwareSnapshot,
  HostKeyPolicy,
  ProbeResult,
  ServerDTO,
  ServerInput,
  ServerStatus,
  ServerTestResult,
  TestStep,
} from '@sm/shared';
import { prepare } from '../db/index.ts';
import { isDemoId } from '../demo/ids.ts';
import { demoProbe, demoServerTest } from '../demo/fixtures.ts';
import { ApiError, notFound } from '../errors.ts';
import { publishGlobal } from '../realtime/events-bus.ts';
import { decryptSecret, encryptSecret, secretAad } from '../crypto/secrets.ts';
import { classifySshError, connectSsh, type ConnectedSsh } from '../transport/ssh/client.ts';
import { runExec } from '../transport/ssh/exec.ts';
import { probeCaps } from '../transport/ssh/caps.ts';
import { probeHardware } from '../transport/ssh/hardware.ts';
import { invalidate, withClient } from '../transport/ssh/pool.ts';
import type { SshConnectConfig } from '../transport/types.ts';

export type ServerRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password_enc: string | null;
  private_key_enc: string | null;
  passphrase_enc: string | null;
  host_key_policy: string;
  host_key_fp: string | null;
  color: string | null;
  tags_json: string;
  notes: string | null;
  sort_order: number;
  status: string;
  status_msg: string | null;
  last_ok_at: number | null;
  caps_json: string;
  hw_json: string | null;
  hw_at: number | null;
  created_at: number;
  updated_at: number;
  target_count?: number;
  running_jobs?: number;
};

export type ServerDraft = {
  host?: string;
  port?: number;
  username?: string;
  authType?: AuthType;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  hostKeyPolicy?: HostKeyPolicy;
};

const SERVER_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM targets t WHERE t.server_id = s.id) AS target_count,
    (SELECT COUNT(*) FROM jobs j WHERE j.server_id = s.id
       AND j.status IN ('pending', 'syncing', 'starting', 'running')) AS running_jobs
  FROM servers s
`;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;
}

export function rowToDto(row: ServerRow): ServerDTO {
  const hardware = parseJson<HardwareSnapshot | null>(row.hw_json, null);
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type as AuthType,
    hasPassword: Boolean(row.password_enc),
    hasPrivateKey: Boolean(row.private_key_enc),
    hasPassphrase: Boolean(row.passphrase_enc),
    hostKeyPolicy: row.host_key_policy as HostKeyPolicy,
    hostKeyFp: row.host_key_fp,
    color: row.color,
    tags: parseJson<string[]>(row.tags_json, []),
    notes: row.notes,
    sortOrder: row.sort_order,
    status: row.status as ServerStatus,
    statusMsg: row.status_msg,
    lastOkAt: iso(row.last_ok_at),
    caps: parseJson<Caps>(row.caps_json, {}),
    hardware,
    hardwareAt: iso(row.hw_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    runningJobs: Number(row.running_jobs ?? 0),
    targetCount: Number(row.target_count ?? 0),
  };
}

export function getServerRow(id: string): ServerRow | undefined {
  return prepare(`${SERVER_SELECT} WHERE s.id = ?`).get(id) as unknown as ServerRow | undefined;
}

function requireServerRow(id: string): ServerRow {
  const row = getServerRow(id);
  if (!row) throw notFound('服务器');
  return row;
}

export function listServers(): ServerDTO[] {
  const rows = prepare(`${SERVER_SELECT} ORDER BY s.sort_order ASC, s.created_at ASC`).all() as unknown as ServerRow[];
  return rows.map(rowToDto);
}

export function getServerDto(id: string): ServerDTO {
  return rowToDto(requireServerRow(id));
}

type NormalizedInput = {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
  hostKeyPolicy: HostKeyPolicy;
  color: string | null;
  tags: string[];
  notes: string | null;
  sortOrder: number;
};

function normalizeInput(input: ServerInput): NormalizedInput {
  return {
    name: input.name.trim(),
    host: input.host.trim(),
    port: input.port ?? 22,
    username: input.username.trim(),
    authType: input.authType,
    password: input.password ?? null,
    privateKey: input.privateKey ?? null,
    passphrase: input.passphrase ?? null,
    hostKeyPolicy: input.hostKeyPolicy ?? 'tofu',
    color: input.color ?? null,
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    notes: input.notes ?? null,
    sortOrder: input.sortOrder ?? 0,
  };
}

function mapUniqueError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('UNIQUE constraint failed: servers.name')) {
    throw new ApiError(409, 'NAME_TAKEN', '服务器名称已存在');
  }
  throw err;
}

function validateCredentials(authType: AuthType, hasPassword: boolean, hasKey: boolean): void {
  if (authType === 'password' && !hasPassword) {
    throw new ApiError(400, 'CREDENTIAL_REQUIRED', '密码认证需要填写密码');
  }
  if (authType === 'key' && !hasKey) {
    throw new ApiError(400, 'CREDENTIAL_REQUIRED', '私钥认证需要粘贴私钥内容');
  }
}

export function createServer(input: ServerInput): ServerDTO {
  const data = normalizeInput(input);
  validateCredentials(data.authType, Boolean(data.password), Boolean(data.privateKey));
  const id = randomUUID();
  const now = Date.now();
  try {
    prepare(
      `INSERT INTO servers
        (id, name, host, port, username, auth_type, password_enc, private_key_enc, passphrase_enc,
         host_key_policy, color, tags_json, notes, sort_order, status, caps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', '{}', ?, ?)`,
    ).run(
      id,
      data.name,
      data.host,
      data.port,
      data.username,
      data.authType,
      data.password ? encryptSecret(data.password, secretAad(id, 'password')) : null,
      data.privateKey ? encryptSecret(data.privateKey, secretAad(id, 'private_key')) : null,
      data.passphrase ? encryptSecret(data.passphrase, secretAad(id, 'passphrase')) : null,
      data.hostKeyPolicy,
      data.color,
      JSON.stringify(data.tags),
      data.notes,
      data.sortOrder,
      now,
      now,
    );
  } catch (err) {
    mapUniqueError(err);
  }
  return getServerDto(id);
}

export function updateServer(id: string, patch: Partial<ServerInput>): ServerDTO {
  const row = requireServerRow(id);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name.trim());
  }
  if (patch.host !== undefined) {
    sets.push('host = ?');
    params.push(patch.host.trim());
  }
  if (patch.port !== undefined) {
    sets.push('port = ?');
    params.push(patch.port);
  }
  if (patch.username !== undefined) {
    sets.push('username = ?');
    params.push(patch.username.trim());
  }
  if (patch.authType !== undefined) {
    sets.push('auth_type = ?');
    params.push(patch.authType);
  }
  if (patch.password !== undefined) {
    sets.push('password_enc = ?');
    params.push(patch.password ? encryptSecret(patch.password, secretAad(id, 'password')) : null);
  }
  if (patch.privateKey !== undefined) {
    sets.push('private_key_enc = ?');
    params.push(patch.privateKey ? encryptSecret(patch.privateKey, secretAad(id, 'private_key')) : null);
  }
  if (patch.passphrase !== undefined) {
    sets.push('passphrase_enc = ?');
    params.push(patch.passphrase ? encryptSecret(patch.passphrase, secretAad(id, 'passphrase')) : null);
  }
  if (patch.hostKeyPolicy !== undefined) {
    sets.push('host_key_policy = ?');
    params.push(patch.hostKeyPolicy);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    params.push(patch.color);
  }
  if (patch.tags !== undefined) {
    sets.push('tags_json = ?');
    params.push(JSON.stringify(patch.tags.map((tag) => tag.trim()).filter(Boolean)));
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    params.push(patch.notes);
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    params.push(patch.sortOrder);
  }

  if (sets.length === 0) return rowToDto(row);

  const finalAuthType = (patch.authType ?? row.auth_type) as AuthType;
  const hasPassword = patch.password !== undefined ? Boolean(patch.password) : Boolean(row.password_enc);
  const hasKey = patch.privateKey !== undefined ? Boolean(patch.privateKey) : Boolean(row.private_key_enc);
  validateCredentials(finalAuthType, hasPassword, hasKey);

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  try {
    prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    mapUniqueError(err);
  }
  invalidate(id);
  return getServerDto(id);
}

export function deleteServer(id: string, force: boolean): { ok: true } {
  requireServerRow(id);
  const targetCount = Number(
    (prepare('SELECT COUNT(*) AS c FROM targets WHERE server_id = ?').get(id) as { c: number }).c,
  );
  if (targetCount > 0 && !force) {
    throw new ApiError(
      409,
      'TARGETS_EXIST',
      `该服务器仍被 ${targetCount} 个目标引用，删除会级联删除这些目标与任务`,
      { targetCount },
    );
  }
  prepare('DELETE FROM servers WHERE id = ?').run(id);
  invalidate(id);
  return { ok: true };
}

function buildConnectConfig(row: ServerRow, draft?: ServerDraft): SshConnectConfig {
  const authType = (draft?.authType ?? row.auth_type) as AuthType;
  const draftPassword = draft?.password ? draft.password : null;
  const draftKey = draft?.privateKey ? draft.privateKey : null;
  const draftPassphrase = draft?.passphrase ? draft.passphrase : null;

  const password =
    authType === 'password'
      ? (draftPassword ?? decryptSecret(row.password_enc, secretAad(row.id, 'password')))
      : null;
  const privateKey =
    authType === 'key'
      ? (draftKey ?? decryptSecret(row.private_key_enc, secretAad(row.id, 'private_key')))
      : null;
  const passphrase =
    authType === 'key'
      ? (draftPassphrase ?? decryptSecret(row.passphrase_enc, secretAad(row.id, 'passphrase')))
      : null;

  if (authType === 'password' && !password) {
    throw new ApiError(400, 'CREDENTIAL_REQUIRED', '缺少密码：请先填写密码');
  }
  if (authType === 'key' && !privateKey) {
    throw new ApiError(400, 'CREDENTIAL_REQUIRED', '缺少私钥：请先粘贴私钥内容');
  }

  return {
    serverId: row.id,
    host: draft?.host?.trim() || row.host,
    port: draft?.port ?? row.port,
    username: draft?.username?.trim() || row.username,
    authType,
    password,
    privateKey,
    passphrase,
    hostKeyPolicy: (draft?.hostKeyPolicy ?? row.host_key_policy) as HostKeyPolicy,
    expectedFingerprint: row.host_key_fp,
  };
}

export function getServerConnectConfig(id: string): SshConnectConfig {
  return buildConnectConfig(requireServerRow(id));
}

function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; message?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const done = (ok: boolean, message?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, message });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, `TCP 连接超时（${timeoutMs}ms）`));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      done(false, `TCP 连接失败：${err.code ?? err.message}`);
    });
  });
}

async function runConnectionTest(cfg: SshConnectConfig): Promise<ServerTestResult> {
  const startedAt = Date.now();
  const steps: TestStep[] = [];

  const tcp = await tcpProbe(cfg.host, cfg.port);
  steps.push({
    name: 'tcp',
    ok: tcp.ok,
    ms: tcp.ms,
    message: tcp.ok ? `TCP 端口 ${cfg.port} 可达` : (tcp.message ?? 'TCP 连接失败'),
  });
  if (!tcp.ok) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      hostKeyFp: null,
      hostKeyChanged: false,
      steps,
      error: { code: 'OFFLINE', message: tcp.message ?? 'TCP 连接失败' },
    };
  }

  const authStarted = Date.now();
  let connected: ConnectedSsh;
  try {
    connected = await connectSsh(cfg);
  } catch (err) {
    const info = classifySshError(err);
    steps.push({ name: 'auth', ok: false, ms: Date.now() - authStarted, message: info.message });
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      hostKeyFp: null,
      hostKeyChanged: info.code === 'HOST_KEY_CHANGED',
      steps,
      error: info,
    };
  }

  steps.push({
    name: 'auth',
    ok: true,
    ms: Date.now() - authStarted,
    message: 'SSH 握手与认证成功',
  });
  const hostKeyFp = connected.fingerprint;
  const hostKeyChanged = Boolean(
    cfg.expectedFingerprint && hostKeyFp && cfg.expectedFingerprint !== hostKeyFp,
  );
  connected.client.on('error', () => {
    // 测试连接上的瞬时错误忽略
  });

  try {
    const execStarted = Date.now();
    const result = await runExec(connected.client, 'echo sm-ok', { timeoutMs: 10000 });
    const execOk = result.code === 0 && result.stdout.includes('sm-ok');
    let caps: Caps | null = null;
    if (execOk) {
      try {
        caps = await probeCaps(connected.client);
      } catch {
        caps = null;
      }
    }
    steps.push({
      name: 'exec',
      ok: execOk,
      ms: Date.now() - execStarted,
      message: execOk ? '远程命令执行正常' : `远程命令执行异常（退出码 ${result.code}）`,
    });
    return {
      ok: execOk,
      latencyMs: Date.now() - startedAt,
      hostKeyFp,
      hostKeyChanged,
      steps,
      caps,
      error: execOk
        ? hostKeyChanged
          ? { code: 'HOST_KEY_CHANGED', message: '主机指纹已变化，已记录新指纹' }
          : null
        : { code: 'EXEC_FAILED', message: result.stderr.trim() || '远程命令执行失败' },
    };
  } finally {
    connected.client.end();
  }
}

export function setServerStatus(
  id: string,
  status: ServerStatus,
  message: string | null,
  options: { touchOk?: boolean } = {},
): void {
  if (!getServerRow(id)) return;
  if (options.touchOk) {
    prepare('UPDATE servers SET status = ?, status_msg = ?, last_ok_at = ? WHERE id = ?').run(
      status,
      message,
      Date.now(),
      id,
    );
  } else {
    prepare('UPDATE servers SET status = ?, status_msg = ? WHERE id = ?').run(status, message, id);
  }
  publishGlobal({ type: 'server.status', serverId: id, status, message });
}

function persistTestResult(id: string, result: ServerTestResult): void {
  if (result.ok) {
    const now = Date.now();
    if (result.caps) {
      prepare(
        `UPDATE servers SET status = 'online', status_msg = ?, last_ok_at = ?,
           host_key_fp = COALESCE(?, host_key_fp), caps_json = ? WHERE id = ?`,
      ).run('连接正常', now, result.hostKeyFp, JSON.stringify(result.caps), id);
    } else {
      prepare(
        `UPDATE servers SET status = 'online', status_msg = ?, last_ok_at = ?,
           host_key_fp = COALESCE(?, host_key_fp) WHERE id = ?`,
      ).run('连接正常', now, result.hostKeyFp, id);
    }
    publishGlobal({ type: 'server.status', serverId: id, status: 'online', message: '连接正常' });
    return;
  }
  const status: ServerStatus =
    result.error?.code === 'AUTH_FAILED'
      ? 'auth_failed'
      : result.error?.code === 'OFFLINE'
        ? 'offline'
        : result.error?.code === 'HOST_KEY_CHANGED'
          ? 'error'
          : 'error';
  prepare('UPDATE servers SET status = ?, status_msg = ? WHERE id = ?').run(
    status,
    result.error?.message ?? '连接失败',
    id,
  );
  publishGlobal({ type: 'server.status', serverId: id, status, message: result.error?.message ?? '连接失败' });
  invalidate(id);
}

export async function testServerById(id: string, draft?: ServerDraft): Promise<ServerTestResult> {
  const row = requireServerRow(id);
  if (isDemoId(id)) return demoServerTest(id);
  const result = await runConnectionTest(buildConnectConfig(row, draft));
  persistTestResult(id, result);
  return result;
}

export async function testServerDraft(input: ServerInput): Promise<ServerTestResult> {
  const data = normalizeInput(input);
  validateCredentials(data.authType, Boolean(data.password), Boolean(data.privateKey));
  const cfg: SshConnectConfig = {
    serverId: `draft-${randomUUID()}`,
    host: data.host,
    port: data.port,
    username: data.username,
    authType: data.authType,
    password: data.password,
    privateKey: data.privateKey,
    passphrase: data.passphrase,
    hostKeyPolicy: data.hostKeyPolicy,
    expectedFingerprint: null,
  };
  return runConnectionTest(cfg);
}

export async function probeServerHardware(id: string): Promise<ProbeResult> {
  const row = requireServerRow(id);
  if (isDemoId(id)) {
    const demo = demoProbe(id);
    if (demo) return demo;
  }
  const cfg = buildConnectConfig(row);
  let hardware: HardwareSnapshot;
  try {
    hardware = await withClient(cfg, (client) => probeHardware(client));
  } catch (err) {
    const info = classifySshError(err);
    const status: ServerStatus = info.code === 'OFFLINE' ? 'offline' : 'error';
    prepare('UPDATE servers SET status = ?, status_msg = ? WHERE id = ?').run(status, info.message, id);
    publishGlobal({ type: 'server.status', serverId: id, status, message: info.message });
    invalidate(id);
    throw new ApiError(502, 'PROBE_FAILED', `硬件信息采集失败：${info.message}`);
  }

  const now = Date.now();
  prepare(
    `UPDATE servers SET hw_json = ?, hw_at = ?, status = 'online', status_msg = NULL,
       last_ok_at = ? WHERE id = ?`,
  ).run(JSON.stringify(hardware), now, now, id);
  publishGlobal({ type: 'server.status', serverId: id, status: 'online', message: null });

  return {
    hardware,
    caps: parseJson<Caps>(row.caps_json, {}),
    hardwareAt: new Date(now).toISOString(),
  };
}