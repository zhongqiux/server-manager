export const AUTH_TYPES = ['password', 'key'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const SERVER_STATUSES = ['unknown', 'online', 'offline', 'auth_failed', 'error'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const SYNC_MODES = ['sftp', 'git'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const HOST_KEY_POLICIES = ['tofu', 'strict'] as const;
export type HostKeyPolicy = (typeof HOST_KEY_POLICIES)[number];

export const JOB_LAUNCHERS = ['tmux', 'screen', 'nohup'] as const;
export type JobLauncher = (typeof JOB_LAUNCHERS)[number];

export const JOB_LAUNCHER_PREFERENCES = ['auto', ...JOB_LAUNCHERS] as const;
export type JobLauncherPreference = (typeof JOB_LAUNCHER_PREFERENCES)[number];

export const JOB_LAUNCHER_LABELS: Record<JobLauncher, string> = {
  tmux: 'tmux 会话',
  screen: 'screen 会话',
  nohup: 'nohup 后台',
};

export const JOB_SESSION_MODES = ['new', 'new_window', 'existing_window'] as const;
export type JobSessionMode = (typeof JOB_SESSION_MODES)[number];

export const JOB_SESSION_MODE_LABELS: Record<JobSessionMode, string> = {
  new: '新建独立会话',
  new_window: '已有会话 · 新窗口',
  existing_window: '已有会话 · 已有窗口',
};

export const REMOTE_SESSION_TOOLS = ['tmux', 'screen'] as const;
export type RemoteSessionTool = (typeof REMOTE_SESSION_TOOLS)[number];

export type RemoteSessionWindow = {
  id: string;
  index: string;
  name: string;
  active: boolean;
  currentCommand: string | null;
};

export type RemoteSession = {
  tool: RemoteSessionTool;
  name: string;
  windows: RemoteSessionWindow[];
};

export type RemoteSessionList = {
  tools: { tmux: boolean; screen: boolean };
  sessions: RemoteSession[];
  warnings: string[];
};

export type Caps = {
  bash?: boolean;
  tmux?: boolean;
  tmuxVersion?: string | null;
  screen?: boolean;
  screenVersion?: string | null;
  git?: boolean;
  gitVersion?: string | null;
  find?: 'gnu' | 'bsd' | 'none';
  stat?: 'gnu' | 'bsd' | 'none';
  tail?: 'gnu' | 'busybox' | 'none';
  nvidiaSmi?: boolean;
  conda?: boolean;
  sftpUtimes?: boolean;
};

export type DiskInfo = {
  mount: string;
  sizeKb: number;
  availKb: number;
};

export type HardwareSnapshot = {
  os?: string | null;
  kernel?: string | null;
  arch?: string | null;
  cpuModel?: string | null;
  cpuPhysical?: number | null;
  cpuLogical?: number | null;
  memTotalMb?: number | null;
  memAvailableMb?: number | null;
  disks?: DiskInfo[];
  gpuList?: { index: number; name: string; memoryTotalMb: number | null }[];
  driverVersion?: string | null;
  cudaVersion?: string | null;
  tmuxVersion?: string | null;
  screenVersion?: string | null;
  gitVersion?: string | null;
  condaEnvs?: string[];
  whoami?: string | null;
  home?: string | null;
  shell?: string | null;
  collectedAt: number;
};

export type GpuProcess = {
  pid: number;
  name: string;
  usedMemoryMb: number | null;
};

export type GpuInfo = {
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
  processes: GpuProcess[];
  memUsedPct: number | null;
  freeGiB: number | null;
  idle: boolean;
};

export type GpuSnapshot = {
  serverId: string;
  supported: boolean;
  reason?: string | null;
  gpus: GpuInfo[];
  idleCount: number;
  collectedAt: number;
  stale?: boolean;
};

export type ServerDTO = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  hostKeyPolicy: HostKeyPolicy;
  hostKeyFp: string | null;
  color: string | null;
  tags: string[];
  notes: string | null;
  sortOrder: number;
  status: ServerStatus;
  statusMsg: string | null;
  lastOkAt: string | null;
  caps: Caps;
  hardware: HardwareSnapshot | null;
  hardwareAt: string | null;
  createdAt: string;
  updatedAt: string;
  gpu?: GpuSnapshot;
  runningJobs?: number;
  targetCount?: number;
};

export type ServerInput = {
  name: string;
  host: string;
  port?: number;
  username: string;
  authType: AuthType;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  hostKeyPolicy?: HostKeyPolicy;
  color?: string | null;
  tags?: string[];
  notes?: string | null;
  sortOrder?: number;
};

export type TestStepName = 'tcp' | 'handshake' | 'auth' | 'exec';
export type TestStep = {
  name: TestStepName;
  ok: boolean;
  ms: number;
  message?: string | null;
};
export type ServerTestResult = {
  ok: boolean;
  latencyMs: number;
  hostKeyFp: string | null;
  hostKeyChanged: boolean;
  steps: TestStep[];
  caps?: Caps | null;
  error?: { code: string; message: string } | null;
};

export type ProbeResult = {
  hardware: HardwareSnapshot;
  caps: Caps;
  hardwareAt: string;
};

export type ProjectDTO = {
  id: string;
  name: string;
  localRoot: string;
  ignoreExtra: string[];
  execBitPolicy: 'auto' | 'all755';
  createdAt: string;
  updatedAt: string;
  targetCount?: number;
};

export type ProjectInput = {
  name: string;
  localRoot: string;
  ignoreExtra?: string[];
  execBitPolicy?: 'auto' | 'all755';
};

export type SftpSyncConfig = {
  mirrorDelete: boolean;
  extraIgnores: string[];
  sizeOnly: boolean;
  preserveMode: boolean;
  protectGlobs: string[];
};

export type GitSyncConfig = {
  remoteUrl: string;
  branch: string;
  remoteName: string;
  sourceKind: 'local' | 'target';
  sourceTargetId: string | null;
  autoCommitOnSource: boolean;
  cloneIfMissing: boolean;
  commitMessageTemplate: string;
};

export type TargetSyncConfig = Partial<SftpSyncConfig> & Partial<GitSyncConfig>;

export type TargetDTO = {
  id: string;
  projectId: string;
  serverId: string;
  label: string | null;
  remoteCodeDir: string;
  dataDir: string | null;
  condaEnv: string | null;
  envVars: Record<string, string>;
  preCommand: string | null;
  runCommand: string;
  gpuDevices: string | null;
  syncMode: SyncMode;
  syncConfig: TargetSyncConfig;
  keepSession: boolean;
  createdAt: string;
  updatedAt: string;
  projectName?: string;
  serverName?: string;
  lastSyncAt?: string | null;
  lastJob?: { id: string; status: import('./job-states.ts').JobStatus; title: string } | null;
};

export type TargetInput = {
  projectId: string;
  serverId: string;
  label?: string | null;
  remoteCodeDir: string;
  dataDir?: string | null;
  condaEnv?: string | null;
  envVars?: Record<string, string>;
  preCommand?: string | null;
  runCommand: string;
  gpuDevices?: string | null;
  syncMode?: SyncMode;
  syncConfig?: TargetSyncConfig;
  keepSession?: boolean;
};

export type JobEventDTO = {
  id: number;
  jobId: string;
  ts: string;
  kind: string;
  message: string | null;
  data: unknown;
};

export type JobDTO = {
  id: string;
  targetId: string;
  projectId: string;
  serverId: string;
  title: string;
  status: import('./job-states.ts').JobStatus;
  launcher: JobLauncher | null;
  sessionName: string | null;
  sessionMode: JobSessionMode;
  windowId: string | null;
  windowName: string | null;
  remotePid: number | null;
  remotePgid: number | null;
  scriptPath: string | null;
  logPath: string | null;
  exitPath: string | null;
  renderedCommand: string;
  scriptContent: string;
  exitCode: number | null;
  error: string | null;
  syncRunId: string | null;
  logBytes: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastSeenAt: string | null;
  projectName?: string;
  serverName?: string;
  targetLabel?: string | null;
  events?: JobEventDTO[];
};

export type JobInput = {
  targetId: string;
  command?: string;
  syncFirst?: boolean;
  title?: string;
  launcher?: JobLauncherPreference;
  sessionMode?: JobSessionMode;
  sessionName?: string;
  windowId?: string;
  windowName?: string;
};

export const SYNC_RUN_STATUSES = [
  'pending',
  'scanning',
  'transferring',
  'deleting',
  'pushing',
  'done',
  'failed',
  'canceled',
] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const SYNC_DIRECTIONS = ['local_to_remote', 'target_to_target', 'remote_to_local'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export type SyncCounts = {
  add: number;
  updateSize: number;
  updateMtime: number;
  same: number;
  delete: number;
  ignored: number;
  protectedSkipped: number;
  skippedSymlinks: number;
};

export type SyncAction = {
  rel: string;
  op: 'add' | 'update' | 'delete';
  reason?: 'missing' | 'size' | 'mtime' | 'orphan';
  size: number;
  mtimeMs: number;
};

export type IgnoreSample = {
  rel: string;
  rule: string;
  source: 'default' | 'project' | 'target' | 'hard';
};

export type SyncPlan = {
  runId: string;
  mode: SyncMode;
  direction: SyncDirection;
  source: { label: string; serverId?: string | null; dir: string };
  dest: { label: string; serverId?: string | null; dir: string };
  counts: SyncCounts;
  bytes: { upload: number; delete: number; totalLocal: number };
  actions: SyncAction[];
  truncated: boolean;
  warnings: string[];
  ignoreSample: IgnoreSample[];
};

export type SyncProgressPhase = 'scanning' | 'transferring' | 'deleting';

export type SyncProgress = {
  phase: SyncProgressPhase;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  rateBps: number;
  etaMs: number | null;
};

export type GitRepoState = {
  available: boolean;
  isRepo: boolean;
  toplevel: string | null;
  branch: string | null;
  detached: boolean;
  head: string | null;
  dirty: string[];
  dirtyCount: number;
  ahead: number | null;
  behind: number | null;
  warnings: string[];
};

export type GitTargetState = {
  state: 'missing' | 'empty' | 'nonempty' | 'repo' | 'error';
  branch: string | null;
  head: string | null;
  dirty: string[];
  dirtyCount: number;
  reason: string | null;
};

export type GitDetectResult = {
  ok: boolean;
  remoteUrl: string;
  branch: string;
  sourceKind: 'local' | 'target';
  local: GitRepoState | null;
  source: GitRepoState | null;
  target: GitTargetState | null;
  warnings: string[];
  error: string | null;
};

export type GitTargetAction = 'reported' | 'cloned' | 'fast_forward' | 'up_to_date';

export type GitRunSummary = {
  remoteUrl: string;
  branch: string;
  sourceKind: 'local' | 'target';
  committed: string | null;
  pushed: boolean;
  ahead: number | null;
  targetAction: GitTargetAction | null;
  local: GitRepoState | null;
  source: GitRepoState | null;
  target: GitTargetState | null;
  warnings: string[];
};

export type SyncRunDTO = {
  id: string;
  projectId: string;
  targetId: string | null;
  mode: SyncMode;
  direction: SyncDirection;
  dryRun: boolean;
  status: SyncRunStatus;
  counts: SyncCounts | null;
  bytes: { upload: number; delete: number; totalLocal: number } | null;
  plan: SyncPlan | null;
  git: GitRunSummary | null;
  outputTail: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type DashboardStats = {
  serversTotal: number;
  serversOnline: number;
  gpuTotal: number;
  gpuIdle: number;
  runningJobs: number;
  syncsToday: number;
};

export type DashboardDTO = {
  stats: DashboardStats;
  servers: ServerDTO[];
  runningJobs: JobDTO[];
  recentSyncs: SyncRunDTO[];
};