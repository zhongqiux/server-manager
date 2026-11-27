import type { Client } from 'ssh2';
import type { GpuInfo, GpuProcess } from '@sm/shared';
import { runExec } from './exec.ts';

export const GPU_QUERY_SCRIPT = `set +e
if ! command -v nvidia-smi >/dev/null 2>&1; then echo '@@NOSMI@@'; exit 0; fi
echo '@@GPUS@@'
nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null
echo '@@APPS@@'
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null
`;

export type GpuCollectResult = {
  supported: boolean;
  reason?: string | null;
  gpus: GpuInfo[];
};

function toNum(raw: string | undefined): number | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text || /^\[?N\/A\]?$/i.test(text) || text === '-') return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGpuLine(line: string): {
  index: number;
  uuid: string;
  name: string;
  memoryTotalMb: number | null;
  memoryUsedMb: number | null;
  memoryFreeMb: number | null;
  utilPercent: number | null;
  memUtilPercent: number | null;
  temperatureC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
} | null {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 11) return null;
  const index = Number.parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(index)) return null;
  const uuid = parts[1] ?? '';
  const tail = parts.slice(-8);
  const name = parts.slice(2, parts.length - 8).join(', ') || 'GPU';
  return {
    index,
    uuid,
    name,
    memoryTotalMb: toNum(tail[0]),
    memoryUsedMb: toNum(tail[1]),
    memoryFreeMb: toNum(tail[2]),
    utilPercent: toNum(tail[3]),
    memUtilPercent: toNum(tail[4]),
    temperatureC: toNum(tail[5]),
    powerW: toNum(tail[6]),
    powerLimitW: toNum(tail[7]),
  };
}

function parseAppsLines(lines: string[]): Map<string, GpuProcess[]> {
  const byUuid = new Map<string, GpuProcess[]>();
  for (const line of lines) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 3) continue;
    const uuid = parts[0] ?? '';
    const pid = Number.parseInt(parts[1] ?? '', 10);
    if (!uuid || !Number.isFinite(pid)) continue;
    const memRaw = parts[parts.length - 1];
    const name = parts.slice(2, parts.length - 1).join(', ') || `PID ${pid}`;
    const list = byUuid.get(uuid) ?? [];
    list.push({ pid, name, usedMemoryMb: toNum(memRaw) });
    byUuid.set(uuid, list);
  }
  return byUuid;
}

export function parseGpuQuery(stdout: string): GpuCollectResult {
  const gpuLines: string[] = [];
  const appLines: string[] = [];
  let section: 'none' | 'gpus' | 'apps' = 'none';
  let noSmi = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '@@NOSMI@@') {
      noSmi = true;
      section = 'none';
      continue;
    }
    if (line === '@@GPUS@@') {
      section = 'gpus';
      continue;
    }
    if (line === '@@APPS@@') {
      section = 'apps';
      continue;
    }
    if (!line) continue;
    if (section === 'gpus') gpuLines.push(line);
    else if (section === 'apps') appLines.push(line);
  }

  if (noSmi) return { supported: false, reason: '未安装 nvidia-smi', gpus: [] };

  const apps = parseAppsLines(appLines);
  const gpus: GpuInfo[] = [];
  for (const line of gpuLines) {
    const parsed = parseGpuLine(line);
    if (!parsed) continue;
    const {
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb,
      utilPercent,
      memUtilPercent,
      temperatureC,
      powerW,
      powerLimitW,
    } = parsed;
    const processes = apps.get(parsed.uuid) ?? [];
    const memUsedPct =
      memoryTotalMb && memoryTotalMb > 0 && memoryUsedMb != null
        ? Math.min(100, Math.max(0, (memoryUsedMb / memoryTotalMb) * 100))
        : null;
    gpus.push({
      index: parsed.index,
      uuid: parsed.uuid,
      name: parsed.name,
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb,
      utilPercent,
      memUtilPercent,
      temperatureC,
      powerW,
      powerLimitW,
      processes,
      memUsedPct,
      freeGiB: memoryFreeMb != null ? Math.round((memoryFreeMb / 1024) * 10) / 10 : null,
      idle: processes.length === 0 && (utilPercent ?? 0) <= 5 && (memUsedPct ?? 0) <= 10,
    });
  }

  if (gpus.length === 0) {
    return { supported: false, reason: 'nvidia-smi 未返回 GPU 信息', gpus: [] };
  }
  return { supported: true, gpus };
}

export async function collectGpu(client: Client): Promise<GpuCollectResult> {
  const result = await runExec(client, GPU_QUERY_SCRIPT, { timeoutMs: 20000, maxBytes: 512 * 1024 });
  if (result.code !== 0 && !result.stdout.includes('@@GPUS@@') && !result.stdout.includes('@@NOSMI@@')) {
    throw new Error(`GPU 查询失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 200) || '无输出'}`);
  }
  return parseGpuQuery(result.stdout);
}