import { Alert, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { SyncAction, SyncPlan } from '@sm/shared';
import { formatBytes } from '../utils/format';

const OP_META: Record<SyncAction['op'], { color: string; label: string }> = {
  add: { color: 'green', label: '新增' },
  update: { color: 'blue', label: '更新' },
  delete: { color: 'red', label: '删除' },
};

const REASON_LABEL: Record<NonNullable<SyncAction['reason']>, string> = {
  missing: '远端缺失',
  size: '大小变化',
  mtime: '修改时间',
  orphan: '远端孤儿',
};

const columns: TableColumnsType<SyncAction> = [
  {
    title: '文件',
    dataIndex: 'rel',
    ellipsis: true,
    render: (value: string) => (
      <span className="mono" style={{ fontSize: 12 }}>
        {value}
      </span>
    ),
  },
  {
    title: '操作',
    dataIndex: 'op',
    width: 76,
    render: (op: SyncAction['op']) => (
      <Tag color={OP_META[op].color} style={{ marginInlineEnd: 0 }}>
        {OP_META[op].label}
      </Tag>
    ),
  },
  {
    title: '原因',
    dataIndex: 'reason',
    width: 100,
    render: (reason: SyncAction['reason']) => (reason ? REASON_LABEL[reason] : '—'),
  },
  {
    title: '大小',
    dataIndex: 'size',
    width: 90,
    align: 'right',
    render: (value: number) => formatBytes(value),
  },
];

export default function SyncPlanView({ plan }: { plan: SyncPlan }) {
  const updates = plan.counts.updateSize + plan.counts.updateMtime;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {plan.warnings.map((warning) => (
        <Alert key={warning} type="warning" showIcon message={warning} />
      ))}
      <Space wrap size={[8, 8]}>
        <Tag color="green">新增 {plan.counts.add}</Tag>
        <Tag color="blue">更新 {updates}</Tag>
        {plan.counts.delete > 0 && <Tag color="red">删除 {plan.counts.delete}</Tag>}
        <Tag>未变 {plan.counts.same}</Tag>
        <Tag>忽略 {plan.counts.ignored}</Tag>
        {plan.counts.protectedSkipped > 0 && (
          <Tag color="orange">受保护 {plan.counts.protectedSkipped}</Tag>
        )}
        <Tag>待上传 {formatBytes(plan.bytes.upload)}</Tag>
        {plan.bytes.delete > 0 && <Tag color="volcano">待删除 {formatBytes(plan.bytes.delete)}</Tag>}
        <Tag>本地总量 {formatBytes(plan.bytes.totalLocal)}</Tag>
      </Space>
      {plan.actions.length > 0 ? (
        <Table
          size="small"
          rowKey="rel"
          columns={columns}
          dataSource={plan.actions}
          pagination={false}
          scroll={{ y: 260, x: 560 }}
        />
      ) : (
        <Typography.Text type="secondary">
          {plan.counts.delete > 0
            ? '没有需要上传的文件，仅执行镜像删除。'
            : '远端已是最新，没有需要传输的文件。'}
        </Typography.Text>
      )}
      {plan.truncated && (
        <Typography.Text type="secondary">
          变更过多，仅展示前 {plan.actions.length} 条。
        </Typography.Text>
      )}
      {plan.ignoreSample.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            忽略样例
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Space wrap size={[6, 6]}>
              {plan.ignoreSample.map((sample) => (
                <Tag key={sample.rel}>
                  <span className="mono" style={{ fontSize: 11 }}>
                    {sample.rel}
                  </span>
                  <span className="text-muted"> ← {sample.rule}</span>
                </Tag>
              ))}
            </Space>
          </div>
        </div>
      )}
    </Space>
  );
}