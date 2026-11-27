import { Tag } from 'antd';
import type { ServerStatus } from '@sm/shared';
import { SERVER_STATUS_META } from '../utils/format';

export default function ServerStatusTag({ status }: { status: ServerStatus }) {
  const meta = SERVER_STATUS_META[status] ?? { color: 'default', label: status };
  return (
    <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
      {meta.label}
    </Tag>
  );
}