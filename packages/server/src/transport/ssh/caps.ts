import type { Client } from 'ssh2';
import type { Caps } from '@sm/shared';
import { runExec } from './exec.ts';

export const CAPS_SCRIPT = `set +e
echo '@@OS@@'; uname -s 2>/dev/null || echo unknown
echo '@@BASH@@'; command -v bash >/dev/null 2>&1 && echo yes || echo no
echo '@@TMUX@@'; command -v tmux >/dev/null 2>&1 && tmux -V 2>/dev/null || echo none
echo '@@SCREEN@@'; command -v screen >/dev/null 2>&1 && screen --version 2>/dev/null | head -n1 || echo none
echo '@@GIT@@'; command -v git >/dev/null 2>&1 && git --version 2>/dev/null || echo none
echo '@@FIND@@'; find --version 2>/dev/null | head -n1
echo '@@STAT@@'; stat --version 2>/dev/null | head -n1
echo '@@TAIL@@'; if tail --version 2>/dev/null | grep -q 'GNU'; then echo gnu; elif busybox --list 2>/dev/null | grep -qx tail; then echo busybox; else echo none; fi
echo '@@NVIDIA@@'; command -v nvidia-smi >/dev/null 2>&1 && echo yes || echo no
echo '@@CONDA@@'; command -v conda >/dev/null 2>&1 && echo yes || echo no
`;

export function parseSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current = '_';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    const marker = /^@@([A-Z0-9_]+)@@$/.exec(line.trim());
    if (marker) {
      current = marker[1]!;
      sections[current] ??= [];
      continue;
    }
    sections[current] ??= [];
    sections[current]!.push(line);
  }
  return sections;
}

function firstLine(sections: Record<string, string[]>, key: string): string {
  return (sections[key] ?? []).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function joinSection(sections: Record<string, string[]>, key: string): string {
  return (sections[key] ?? [])
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

export function parseCaps(stdout: string): Caps & { os: string | null } {
  const sections = parseSections(stdout);
  const tmuxRaw = firstLine(sections, 'TMUX');
  const screenRaw = firstLine(sections, 'SCREEN');
  const gitRaw = firstLine(sections, 'GIT');
  const findRaw = firstLine(sections, 'FIND');
  const statRaw = firstLine(sections, 'STAT');
  const tailRaw = firstLine(sections, 'TAIL');

  const find: Caps['find'] = /GNU/i.test(findRaw) ? 'gnu' : findRaw ? 'bsd' : 'none';
  const stat: Caps['stat'] = /GNU/i.test(statRaw) ? 'gnu' : statRaw ? 'bsd' : 'none';
  const tail: Caps['tail'] = tailRaw === 'gnu' ? 'gnu' : tailRaw === 'busybox' ? 'busybox' : 'none';

  return {
    os: firstLine(sections, 'OS') || null,
    bash: firstLine(sections, 'BASH') === 'yes',
    tmux: tmuxRaw !== '' && tmuxRaw !== 'none',
    tmuxVersion: tmuxRaw && tmuxRaw !== 'none' ? tmuxRaw : null,
    screen: screenRaw !== '' && screenRaw !== 'none',
    screenVersion: screenRaw && screenRaw !== 'none' ? screenRaw : null,
    git: gitRaw !== '' && gitRaw !== 'none',
    gitVersion: gitRaw && gitRaw !== 'none' ? gitRaw : null,
    find,
    stat,
    tail,
    nvidiaSmi: firstLine(sections, 'NVIDIA') === 'yes',
    conda: firstLine(sections, 'CONDA') === 'yes',
    sftpUtimes: true,
  };
}

export async function probeCaps(client: Client): Promise<Caps> {
  const result = await runExec(client, CAPS_SCRIPT, { timeoutMs: 20000 });
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(`能力探测失败（退出码 ${result.code}）：${result.stderr.slice(0, 300)}`);
  }
  const { os: _os, ...caps } = parseCaps(result.stdout);
  return caps;
}