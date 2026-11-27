import { Empty, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import type { SyncRunDTO, SyncRunStatus } from '@sm/shared';
import SyncStatusTag from './SyncStatusTag';
import { formatBytes, formatDateTime, formatDurationMs } from '../utils/format';

const historyColumns: TableColumnsType<SyncRunDTO> = [
  {
    title: '开始时间',
    dataIndex: 'startedAt',
    width: 132,
    render: (value: string) => formatDateTime(value),
  },
  {
    title: '类型',
    dataIndex: 'dryRun',
    width: 130,
    render: (dryRun: boolean, run) => (
      <Space size={4} wrap>
        <Tag style={{ marginInlineEnd: 0 }}>{dryRun ? '检查' : '同步'}</Tag>
        {run.mode === 'git' && (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            Git
          </Tag>
        )}
        {run.direction === 'target_to_target' && (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            中转
          </Tag>
        )}
      </Space>
    ),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 84,
    render: (status: SyncRunStatus) => <SyncStatusTag status={status} />,
  },
  {
    title: '变更',
    key: 'changes',
    render: (_, run) => {
      if (run.mode === 'git') {
        if (run.dryRun) return '仅检查';
        if (!run.git) return '—';
        return run.git.committed ? `提交 ${run.git.committed.slice(0, 7)}` : '无新提交';
      }
      if (!run.counts) return '—';
      return `+${run.counts.add} / ~${run.counts.updateSize + run.counts.updateMtime}${
        run.counts.delete > 0 ? ` / -${run.counts.delete}` : ''
      }`;
    },
  },
  {
    title: '上传',
    key: 'upload',
    width: 90,
    render: (_, run) => {
      if (run.mode === 'git') {
        if (!run.git) return '—';
        return run.git.pushed ? '已推送' : '未推送';
      }
      return formatBytes(run.bytes?.upload ?? 0);
    },
  },
  {
    title: '耗时',
    key: 'duration',
    width: 84,
    render: (_, run) =>
      run.finishedAt
        ? formatDurationMs(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
        : '—',
  },
];

export default function SyncHistoryTable({
  runs,
  onInspect,
  disabled = false,
}: {
  runs: SyncRunDTO[];
  onInspect?: (run: SyncRunDTO) => void;
  disabled?: boolean;
}) {
  return (
    <Table
      size="small"
      style={{ marginTop: 6 }}
      rowKey="id"
      columns={historyColumns}
      dataSource={runs}
      pagination={false}
      scroll={{ x: 560 }}
      locale={{
        emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无同步记录" />,
      }}
      onRow={(run) => ({
        onClick: () => {
          if (!disabled) onInspect?.(run);
        },
        style: { cursor: disabled ? 'default' : 'pointer' },
      })}
    />
  );
}