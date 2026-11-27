import type { ServerStatus } from '@sm/shared';

export const SERVER_STATUS_META: Record<ServerStatus, { color: string; label: string }> = {
  unknown: { color: 'default', label: '未测试' },
  online: { color: 'success', label: '在线' },
  offline: { color: 'error', label: '离线' },
  auth_failed: { color: 'warning', label: '认证失败' },
  error: { color: 'error', label: '异常' },
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTimeSec(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatJobDuration(job: {
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}): string {
  const start = new Date(job.startedAt ?? job.createdAt).getTime();
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  return formatDurationMs(end - start);
}

export function formatGb(mb: number | null | undefined, digits = 0): string {
  if (mb == null) return '—';
  return `${(mb / 1024).toFixed(digits)} GB`;
}

export function formatDiskGb(kb: number | null | undefined, digits = 1): string {
  if (kb == null) return '—';
  return `${(kb / 1024 / 1024).toFixed(digits)} GB`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(digits)} ${units[index]}`;
}