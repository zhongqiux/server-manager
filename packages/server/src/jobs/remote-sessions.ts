import type {
  RemoteSession,
  RemoteSessionList,
  RemoteSessionTool,
  RemoteSessionWindow,
} from '@sm/shared';
import { shq } from '@sm/shared';
import { getServerConnectConfig } from '../services/servers.ts';
import { execRemote } from '../transport/ssh/pool.ts';

const TMUX_FORMAT = [
  '#{session_name}',
  '#{window_id}',
  '#{window_index}',
  '#{window_name}',
  '#{window_active}',
  '#{pane_current_command}',
].join('\t');

const SCREEN_SESSION_SED = String.raw`s/^[[:space:]]*\([0-9][0-9]*\)\.\([^[:space:]]*\).*/SM_SCRSESS|\2/p`;

export function buildRemoteSessionsCommand(): string {
  return [
    'set +e',
    'if command -v tmux >/dev/null 2>&1; then',
    '  echo TMUX_TOOL=1',
    `  tmux list-windows -a -F ${shq(TMUX_FORMAT)} 2>/dev/null | while IFS= read -r line; do printf "SM_TMWIN\\t%s\\n" "$line"; done`,
    'else',
    '  echo TMUX_TOOL=0',
    'fi',
    'if command -v screen >/dev/null 2>&1; then',
    '  echo SCREEN_TOOL=1',
    `  screen -ls 2>/dev/null | tr -d '\\r' | sed -n ${shq(SCREEN_SESSION_SED)} | while IFS= read -r line; do s=\${line#SM_SCRSESS|}; [ -z "$s" ] && continue; wins=$(screen -S "$s" -Q windows 2>/dev/null); printf "SM_SCRWIN\\t%s\\t%s\\n" "$s" "$wins"; done`,
    'else',
    '  echo SCREEN_TOOL=0',
    'fi',
    'echo SM_LIST_DONE=1',
  ].join('\n');
}

export function parseScreenWindowsOutput(text: string): RemoteSessionWindow[] {
  const normalized = text.replace(/\r/g, '').replace(/\n/g, '  ').trim();
  if (!normalized) return [];
  const windows: RemoteSessionWindow[] = [];
  const pattern = /(?:^|\s{2,})(\d+)[*$!+-]?\s+(.+?)(?=\s{2,}\d+[*$!+-]?\s+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const index = match[1]!;
    windows.push({
      id: index,
      index,
      name: match[2]!.trim(),
      active: false,
      currentCommand: null,
    });
  }
  return windows;
}

function screenWindowFromLine(line: string): { session: string; windows: RemoteSessionWindow[] } | null {
  const body = line.slice('SM_SCRWIN\t'.length);
  if (!body) return null;
  const firstTab = body.indexOf('\t');
  if (firstTab < 0) return { session: body, windows: [] };
  return {
    session: body.slice(0, firstTab),
    windows: parseScreenWindowsOutput(body.slice(firstTab + 1)),
  };
}

export function parseRemoteSessionsOutput(stdout: string): RemoteSessionList {
  const result: RemoteSessionList = {
    tools: { tmux: false, screen: false },
    sessions: [],
    warnings: [],
  };
  const byKey = new Map<string, RemoteSession>();
  let done = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, '');
    if (!line) continue;
    if (line === 'TMUX_TOOL=1') result.tools.tmux = true;
    else if (line === 'SCREEN_TOOL=1') result.tools.screen = true;
    else if (line === 'SM_LIST_DONE=1') done = true;
    else if (line.startsWith('SM_TMWIN\t')) {
      const fields = line.slice('SM_TMWIN\t'.length).split('\t');
      if (fields.length < 6) continue;
      const name = fields.slice(3, fields.length - 2).join('\t');
      const sessionName = fields[0]!;
      const tool: RemoteSessionTool = 'tmux';
      const key = `${tool}\0${sessionName}`;
      let session = byKey.get(key);
      if (!session) {
        session = { tool, name: sessionName, windows: [] };
        byKey.set(key, session);
      }
      session.windows.push({
        id: fields[1]!,
        index: fields[2]!,
        name,
        active: fields[4] === '1',
        currentCommand: fields[fields.length - 1] || null,
      });
    } else if (line.startsWith('SM_SCRWIN\t')) {
      const parsed = screenWindowFromLine(line);
      if (!parsed) continue;
      const tool: RemoteSessionTool = 'screen';
      const key = `${tool}\0${parsed.session}`;
      let session = byKey.get(key);
      if (!session) {
        session = { tool, name: parsed.session, windows: [] };
        byKey.set(key, session);
      }
      session.windows = parsed.windows;
    }
  }

  result.sessions = [...byKey.values()].sort((a, b) => {
    if (a.tool !== b.tool) return a.tool === 'tmux' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!done) result.warnings.push('会话列表命令未正常结束，结果可能不完整');
  if (result.sessions.length === 0 && (result.tools.tmux || result.tools.screen)) {
    result.warnings.push('服务器上没有正在运行的 tmux / screen 会话');
  }
  return result;
}

export async function listRemoteSessions(serverId: string): Promise<RemoteSessionList> {
  const cfg = getServerConnectConfig(serverId);
  const result = await execRemote(cfg, buildRemoteSessionsCommand(), {
    timeoutMs: 20_000,
    maxBytes: 512 * 1024,
  });
  const parsed = parseRemoteSessionsOutput(result.stdout);
  if (result.code !== 0 && parsed.sessions.length === 0) {
    const message = (result.stderr || result.stdout).trim().slice(0, 500);
    parsed.warnings.push(`列出远程会话失败${message ? `：${message}` : ''}`);
  }
  return parsed;
}