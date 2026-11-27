import { Badge, Tag } from 'antd';
import { isJobActive, jobStatusLabel, type JobStatus } from '@sm/shared';

const COLORS: Record<JobStatus, string> = {
  pending: 'default',
  syncing: 'processing',
  starting: 'processing',
  running: 'success',
  exited: 'default',
  failed: 'error',
  canceled: 'warning',
  lost: 'warning',
  sync_failed: 'error',
  start_failed: 'error',
};

export default function JobStatusTag({
  status,
  showBadge = false,
}: {
  status: JobStatus;
  showBadge?: boolean;
}) {
  const label = jobStatusLabel(status);
  if (showBadge || isJobActive(status)) {
    return (
      <Tag color={COLORS[status]} style={{ marginInlineEnd: 0 }}>
        {isJobActive(status) && <Badge status="processing" style={{ marginInlineEnd: 6 }} />}
        {label}
      </Tag>
    );
  }
  return (
    <Tag color={COLORS[status]} style={{ marginInlineEnd: 0 }}>
      {label}
    </Tag>
  );
}