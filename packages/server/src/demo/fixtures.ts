import type {
  Caps,
  GpuInfo,
  GpuSnapshot,
  HardwareSnapshot,
  ProjectScanResult,
  RemoteSessionList,
  ServerTestResult,
} from '@sm/shared';
import { listJobs } from '../services/jobs.ts';
import { DEMO_SERVER } from './ids.ts';

export const DEMO_CAPS: Caps = {
  bash: true,
  tmux: true,
  tmuxVersion: '3.4',
  screen: true,
  screenVersion: 'Screen version 4.09.00 (GNU)',
  git: true,
  gitVersion: '2.43.0',
  find: 'gnu',
  stat: 'gnu',
  tail: 'gnu',
  nvidiaSmi: true,
  conda: true,
  sftpUtimes: true,
};

const HW: Record<string, Omit<HardwareSnapshot, 'collectedAt'>> = {
  [DEMO_SERVER.a100]: {
    os: 'Ubuntu 22.04.4 LTS',
    kernel: '5.15.0-105-generic',
    arch: 'x86_64',
    cpuModel: 'AMD EPYC 7543 32-Core Processor',
    cpuPhysical: 32,
    cpuLogical: 64,
    memTotalMb: 515_396,
    memAvailableMb: 368_112,
    disks: [
      { mount: '/', sizeKb: 1_899_000_000, availKb: 742_000_000 },
      { mount: '/mnt/nvme', sizeKb: 3_840_000_000, availKb: 1_260_000_000 },
    ],
    gpuList: [
      { index: 0, name: 'NVIDIA A100-SXM4-80GB', memoryTotalMb: 81_920 },
      { index: 1, name: 'NVIDIA A100-SXM4-80GB', memoryTotalMb: 81_920 },
    ],
    driverVersion: '535.161.07',
    cudaVersion: '12.2',
    tmuxVersion: '3.4',
    screenVersion: 'Screen version 4.09.00 (GNU)',
    gitVersion: '2.43.0',
    condaEnvs: ['base', 'torch210', 'af2'],
    whoami: 'gpu',
    home: '/home/gpu',
    shell: '/bin/bash',
  },
  [DEMO_SERVER.rtx4090]: {
    os: 'Ubuntu 22.04.3 LTS',
    kernel: '6.5.0-27-generic',
    arch: 'x86_64',
    cpuModel: 'Intel(R) Core(TM) i9-13900K',
    cpuPhysical: 24,
    cpuLogical: 32,
    memTotalMb: 131_072,
    memAvailableMb: 46_200,
    disks: [{ mount: '/', sizeKb: 1_899_000_000, availKb: 910_000_000 }],
    gpuList: [{ index: 0, name: 'NVIDIA GeForce RTX 4090', memoryTotalMb: 24_564 }],
    driverVersion: '550.54.15',
    cudaVersion: '12.4',
    tmuxVersion: '3.4',
    screenVersion: 'Screen version 4.09.00 (GNU)',
    gitVersion: '2.43.0',
    condaEnvs: ['base', 'diffusers', 'sd-webui'],
    whoami: 'lab',
    home: '/home/lab',
    shell: '/bin/bash',
  },
  [DEMO_SERVER.cloud]: {
    os: 'Ubuntu 20.04.6 LTS',
    kernel: '5.4.0-176-generic',
    arch: 'x86_64',
    cpuModel: 'Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz',
    cpuPhysical: 40,
    cpuLogical: 80,
    memTotalMb: 262_104,
    memAvailableMb: 228_704,
    disks: [{ mount: '/', sizeKb: 1_048_000_000, availKb: 512_000_000 }],
    gpuList: [
      { index: 0, name: 'NVIDIA GeForce RTX 3090', memoryTotalMb: 24_576 },
      { index: 1, name: 'NVIDIA GeForce RTX 3090', memoryTotalMb: 24_576 },
      { index: 2, name: 'NVIDIA GeForce RTX 3090', memoryTotalMb: 24_576 },
      { index: 3, name: 'NVIDIA GeForce RTX 3090', memoryTotalMb: 24_576 },
    ],
    driverVersion: '525.147.05',
    cudaVersion: '11.8',
    tmuxVersion: '3.0a',
    screenVersion: 'Screen version 4.08.00 (GNU)',
    gitVersion: '2.25.1',
    condaEnvs: ['base', 'pt21'],
    whoami: 'root',
    home: '/root',
    shell: '/bin/bash',
  },
};

export function demoHardware(serverId: string): HardwareSnapshot | null {
  const base = HW[serverId];
  if (!base) return null;
  return { ...base, collectedAt: Date.now() };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function gpuInfo(options: {
  serverId: string;
  index: number;
  name: string;
  memoryTotalMb: number;
  utilBase: number;
  utilAmp: number;
  phase: number;
  processes: { pid: number; name: string; usedMemoryMb: number | null }[];
}): GpuInfo {
  const t = Date.now() / 1000;
  const wave = Math.sin(t / 23 + options.phase) * options.utilAmp;
  const util = options.processes.length > 0
    ? clamp(Math.round(options.utilBase + wave), 1, 100)
    : clamp(Math.round(options.utilBase + wave), 0, 100);
  const total = options.memoryTotalMb;
  const used = options.processes.length > 0
    ? Math.round(total * clamp((options.utilBase + wave) / 110, 0.05, 0.97))
    : Math.round(total * 0.015);
  const free = total - used;
  const memUsedPct = Math.round((used / total) * 1000) / 10;
  const idle = options.processes.length === 0 && util < 10;
  return {
    index: options.index,
    uuid: `GPU-demo-${options.serverId.slice(-4)}-${options.index}`,
    name: options.name,
    memoryTotalMb: total,
    memoryUsedMb: used,
    memoryFreeMb: free,
    utilPercent: util,
    memUtilPercent: Math.round(memUsedPct * 0.8),
    temperatureC: idle ? 31 : 62 + Math.round(Math.sin(t / 17 + options.phase) * 4),
    powerW: idle ? 32 : Math.round(options.utilBase * 3.4 + wave * 5),
    powerLimitW: options.name.includes('A100') ? 400 : 350,
    processes: options.processes,
    memUsedPct,
    freeGiB: Math.round((free / 1024) * 10) / 10,
    idle,
  };
}

export function demoGpuSnapshot(serverId: string): GpuSnapshot | null {
  if (!HW[serverId]) return null;
  const activeJobs = listJobs({ serverId, active: true, limit: 20 });
  const runningPids = activeJobs
    .map((job) => job.remotePid)
    .filter((pid): pid is number => typeof pid === 'number');

  let gpus: GpuInfo[];
  if (serverId === DEMO_SERVER.a100) {
    const busyProc = runningPids[0];
    gpus = [
      gpuInfo({
        serverId,
        index: 0,
        name: 'NVIDIA A100-SXM4-80GB',
        memoryTotalMb: 81_920,
        utilBase: 87,
        utilAmp: 6,
        phase: 0.4,
        processes: busyProc ? [{ pid: busyProc, name: 'python', usedMemoryMb: 68_140 }] : [],
      }),
      gpuInfo({
        serverId,
        index: 1,
        name: 'NVIDIA A100-SXM4-80GB',
        memoryTotalMb: 81_920,
        utilBase: 2,
        utilAmp: 2,
        phase: 2.1,
        processes: [],
      }),
    ];
  } else if (serverId === DEMO_SERVER.rtx4090) {
    const busyProc = runningPids[0];
    gpus = [
      gpuInfo({
        serverId,
        index: 0,
        name: 'NVIDIA GeForce RTX 4090',
        memoryTotalMb: 24_564,
        utilBase: 96,
        utilAmp: 3,
        phase: 1.2,
        processes: busyProc ? [{ pid: busyProc, name: 'python', usedMemoryMb: 22_380 }] : [],
      }),
    ];
  } else {
    gpus = [0, 1, 2, 3].map((index) =>
      gpuInfo({
        serverId,
        index,
        name: 'NVIDIA GeForce RTX 3090',
        memoryTotalMb: 24_576,
        utilBase: 1 + index * 0.6,
        utilAmp: 1.2,
        phase: index * 1.7,
        processes: [],
      }),
    );
  }

  return {
    serverId,
    supported: true,
    reason: null,
    gpus,
    idleCount: gpus.filter((gpu) => gpu.idle).length,
    collectedAt: Date.now(),
    stale: false,
  };
}

export function demoServerTest(serverId: string): ServerTestResult {
  const base = serverId === DEMO_SERVER.cloud ? 62 : serverId === DEMO_SERVER.rtx4090 ? 21 : 14;
  return {
    ok: true,
    latencyMs: base,
    hostKeyFp: `SHA256:demo${serverId.slice(-6)}fingerprint`,
    hostKeyChanged: false,
    steps: [
      { name: 'tcp', ok: true, ms: Math.round(base * 0.4), message: 'TCP 端口可达（演示数据）' },
      { name: 'auth', ok: true, ms: Math.round(base * 0.3), message: 'SSH 握手与认证成功（演示数据）' },
      { name: 'exec', ok: true, ms: Math.round(base * 0.2), message: '远程命令执行正常（演示数据）' },
    ],
    caps: DEMO_CAPS,
    error: null,
  };
}

export function demoProbe(serverId: string): { hardware: HardwareSnapshot; caps: Caps; hardwareAt: string } | null {
  const hardware = demoHardware(serverId);
  if (!hardware) return null;
  return { hardware, caps: DEMO_CAPS, hardwareAt: new Date().toISOString() };
}

export function demoRemoteSessions(serverId: string): RemoteSessionList {
  const sessions: RemoteSessionList = {
    tools: { tmux: true, screen: true },
    sessions: [],
    warnings: [],
  };
  if (serverId === DEMO_SERVER.a100) {
    sessions.sessions.push(
      {
        tool: 'tmux',
        name: 'protein',
        windows: [
          {
            id: '@0',
            index: '0',
            name: 'train',
            active: true,
            currentCommand: 'python',
          },
          {
            id: '@1',
            index: '1',
            name: 'shell',
            active: false,
            currentCommand: 'bash',
          },
        ],
      },
      {
        tool: 'screen',
        name: 'af2',
        windows: [
          { id: '0', index: '0', name: 'bash', active: false, currentCommand: null },
          { id: '1', index: '1', name: 'logs', active: false, currentCommand: null },
        ],
      },
    );
  } else if (serverId === DEMO_SERVER.rtx4090) {
    sessions.sessions.push({
      tool: 'tmux',
      name: 'lab',
      windows: [{ id: '@4', index: '0', name: 'bash', active: true, currentCommand: 'bash' }],
    });
  } else if (serverId === DEMO_SERVER.cloud) {
    sessions.sessions.push({
      tool: 'screen',
      name: 'autodl',
      windows: [
        { id: '0', index: '0', name: 'bash', active: false, currentCommand: null },
        { id: '1', index: '1', name: 'training', active: false, currentCommand: null },
      ],
    });
  }
  if (sessions.sessions.length === 0) {
    sessions.warnings.push('服务器上没有正在运行的 tmux / screen 会话');
  }
  return sessions;
}

export function demoProjectScan(project: {
  name: string;
  local_root: string;
}): ProjectScanResult {
  const isProtein = project.name.includes('蛋白');
  return {
    root: project.local_root,
    files: isProtein ? 187 : 264,
    dirs: isProtein ? 24 : 31,
    bytes: isProtein ? 12_685_312 : 28_412_900,
    ignoredEntries: isProtein ? 61 : 148,
    skippedSymlinks: 0,
    truncated: false,
    durationMs: isProtein ? 132 : 208,
    topLevel: isProtein
      ? [
          { name: 'configs', type: 'dir', ignored: false, size: null },
          { name: 'src', type: 'dir', ignored: false, size: null },
          { name: 'train.py', type: 'file', ignored: false, size: 8421 },
          { name: 'requirements.txt', type: 'file', ignored: false, size: 412 },
          { name: 'README.md', type: 'file', ignored: false, size: 2304 },
          { name: 'checkpoints', type: 'dir', ignored: true, size: null },
          { name: '.venv', type: 'dir', ignored: true, size: null },
        ]
      : [
          { name: 'configs', type: 'dir', ignored: false, size: null },
          { name: 'scripts', type: 'dir', ignored: false, size: null },
          { name: 'train_lora.py', type: 'file', ignored: false, size: 15_204 },
          { name: 'accelerate.yaml', type: 'file', ignored: false, size: 1902 },
          { name: 'runs', type: 'dir', ignored: true, size: null },
          { name: 'outputs', type: 'dir', ignored: true, size: null },
          { name: '__pycache__', type: 'dir', ignored: true, size: null },
        ],
  };
}