import { Progress } from 'antd';

export function gpuColor(percent: number): string {
  if (percent >= 85) return '#dc2626';
  if (percent >= 60) return '#d97706';
  return '#16a34a';
}

export function formatGib(mb: number | null | undefined): string {
  if (mb == null) return '—';
  return `${(mb / 1024).toFixed(1)} GiB`;
}

export default function GpuBar({
  percent,
  strokeWidth = 6,
}: {
  percent: number | null | undefined;
  strokeWidth?: number;
}) {
  const value = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <Progress
      percent={Math.round(value)}
      showInfo={false}
      size="small"
      strokeWidth={strokeWidth}
      strokeColor={gpuColor(value)}
      trailColor="#e2e8f0"
      style={{ margin: 0 }}
    />
  );
}