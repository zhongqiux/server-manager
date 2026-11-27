import { Tag } from 'antd';
import type { SyncRunStatus } from '@sm/shared';

export const SYNC_STATUS_META: Record<SyncRunStatus, { color: string; label: string }> = {
  pending: { color: 'default', label: '排队中' },
  scanning: { color: 'processing', label: '扫描中' },
  transferring: { color: 'processing', label: '传输中' },
  deleting: { color: 'processing', label: '删除中' },
  pushing: { color: 'processing', label: '推送中' },
  done: { color: 'success', label: '完成' },
  failed: { color: 'error', label: '失败' },
  canceled: { color: 'warning', label: '已取消' },
};

export default function SyncStatusTag({ status }: { status: SyncRunStatus }) {
  const meta = SYNC_STATUS_META[status];
  return (
    <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
      {meta.label}
    </Tag>
  );
}