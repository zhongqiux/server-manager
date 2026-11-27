export const JOB_STATUSES = [
  'pending',
  'syncing',
  'starting',
  'running',
  'exited',
  'failed',
  'canceled',
  'lost',
  'sync_failed',
  'start_failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  'exited',
  'failed',
  'canceled',
  'lost',
  'sync_failed',
  'start_failed',
];

export const JOB_ACTIVE_STATUSES: readonly JobStatus[] = ['pending', 'syncing', 'starting', 'running'];

export function isJobActive(status: JobStatus): boolean {
  return JOB_ACTIVE_STATUSES.includes(status);
}

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['syncing', 'starting', 'canceled', 'start_failed', 'sync_failed'],
  syncing: ['starting', 'sync_failed', 'canceled'],
  starting: ['running', 'exited', 'failed', 'start_failed', 'canceled', 'lost'],
  running: ['exited', 'failed', 'canceled', 'lost'],
  exited: [],
  failed: [],
  canceled: [],
  lost: ['exited', 'failed'],
  sync_failed: [],
  start_failed: [],
};

export function isJobTerminal(status: JobStatus): boolean {
  return JOB_TERMINAL_STATUSES.includes(status);
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function jobStatusLabel(status: JobStatus): string {
  switch (status) {
    case 'pending':
      return '待启动';
    case 'syncing':
      return '同步中';
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'exited':
      return '已结束';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'lost':
      return '状态丢失';
    case 'sync_failed':
      return '同步失败';
    case 'start_failed':
      return '启动失败';
    default:
      return status;
  }
}