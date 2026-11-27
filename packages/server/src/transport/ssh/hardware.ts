import type { Client } from 'ssh2';
import type { DiskInfo, HardwareSnapshot } from '@sm/shared';
import { runExec } from './exec.ts';
import { parseSections } from './caps.ts';

export const HARDWARE_SCRIPT = `set +e
echo '@@WHOAMI@@'; whoami 2>/dev/null
echo '@@HOME@@'; printf '%s\\n' "\${HOME:-}"
echo '@@SHELL@@'; printf '%s\\n' "\${SHELL:-}"
echo '@@OS@@'; ( . /etc/os-release 2>/dev/null && printf '%s\\n' "\${PRETTY_NAME:-}" ) || uname -s
echo '@@KERNEL@@'; uname -r 2>/dev/null
echo '@@ARCH@@'; uname -m 2>/dev/null
echo '@@CPU@@'; (grep -m1 -i 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-) || (lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n1)
echo '@@CPUCOUNT@@'; (nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)
echo '@@MEM@@'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}'
echo '@@DISKS@@'; df -Pk "$HOME" / 2>/dev/null | tail -n +2 | awk '{print $6"|"$2"|"$4}'
echo '@@GPU@@'; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits 2>/dev/null; fi
echo '@@DRIVER@@'; nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1
echo '@@CUDA@@'; nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\\([0-9.]*\\).*/\\1/p' | head -n1
echo '@@TMUXV@@'; tmux -V 2>/dev/null
echo '@@SCREENV@@'; screen --version 2>/dev/null | head -n1
echo '@@GITV@@'; git --version 2>/dev/null
echo '@@CONDAENVS@@'; if command -v conda >/dev/null 2>&1; then conda env list 2>/dev/null | awk '!/^#/ {print $1}'; else ls -1 "$HOME/miniconda3/envs" "$HOME/anaconda3/envs" /opt/conda/envs 2>/dev/null; fi
`;

function firstLine(sections: Record<string, string[]>, key: string): string | null {
  const value = (sections[key] ?? []).find((line) => line.trim().length > 0)?.trim();
  return value && value.length > 0 ? value : null;
}

function sectionLines(sections: Record<string, string[]>, key: string): string[] {
  return (sections[key] ?? []).map((line) => line.trim()).filter(Boolean);
}

function toInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseHardware(stdout: string): HardwareSnapshot {
  const sections = parseSections(stdout);
  const memLines = sectionLines(sections, 'MEM');
  const disks: DiskInfo[] = [];
  const seenMounts = new Set<string>();
  for (const line of sectionLines(sections, 'DISKS')) {
    const [mount, sizeKb, availKb] = line.split('|');
    if (!mount || seenMounts.has(mount)) continue;
    seenMounts.add(mount);
    disks.push({ mount, sizeKb: toInt(sizeKb) ?? 0, availKb: toInt(availKb) ?? 0 });
  }

  const gpuList: NonNullable<HardwareSnapshot['gpuList']> = [];
  for (const line of sectionLines(sections, 'GPU')) {
    const match = /^(\d+)\s*,\s*(.*?)\s*,\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, indexRaw, name, memRaw] = match;
    const mem = /^\[?N\/A\]?$/i.test(memRaw ?? '') ? null : toInt(memRaw);
    gpuList.push({ index: Number(indexRaw), name: name ?? 'GPU', memoryTotalMb: mem });
  }

  const condaEnvs = sectionLines(sections, 'CONDAENVS')
    .map((line) => line.replace(/^\*\s*/, '').trim())
    .filter((line) => line.length > 0);

  return {
    os: firstLine(sections, 'OS'),
    kernel: firstLine(sections, 'KERNEL'),
    arch: firstLine(sections, 'ARCH'),
    cpuModel: firstLine(sections, 'CPU'),
    cpuPhysical: null,
    cpuLogical: toInt(firstLine(sections, 'CPUCOUNT') ?? undefined),
    memTotalMb: toInt(memLines[0]),
    memAvailableMb: toInt(memLines[1]),
    disks,
    gpuList,
    driverVersion: firstLine(sections, 'DRIVER'),
    cudaVersion: firstLine(sections, 'CUDA'),
    tmuxVersion: firstLine(sections, 'TMUXV'),
    screenVersion: firstLine(sections, 'SCREENV'),
    gitVersion: firstLine(sections, 'GITV'),
    condaEnvs,
    whoami: firstLine(sections, 'WHOAMI'),
    home: firstLine(sections, 'HOME'),
    shell: firstLine(sections, 'SHELL'),
    collectedAt: Date.now(),
  };
}

export async function probeHardware(client: Client): Promise<HardwareSnapshot> {
  const result = await runExec(client, HARDWARE_SCRIPT, { timeoutMs: 30000, maxBytes: 1024 * 1024 });
  if (!result.stdout.trim()) {
    throw new Error(`硬件信息采集失败（退出码 ${result.code}）：${result.stderr.slice(0, 300) || '无输出'}`);
  }
  return parseHardware(result.stdout);
}