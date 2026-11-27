import { Button, Descriptions, Empty, Space, Table, Tag, Typography } from 'antd';
import type { HardwareSnapshot } from '@sm/shared';
import { formatDateTime, formatDiskGb, formatGb } from '../utils/format';

type Props = {
  hardware: HardwareSnapshot | null;
  onProbe?: () => void;
  probing?: boolean;
};

export default function HardwareView({ hardware, onProbe, probing }: Props) {
  if (!hardware) {
    return (
      <Empty description="尚未采集硬件信息">
        {onProbe && (
          <Button type="primary" loading={probing} onClick={onProbe}>
            采集硬件信息
          </Button>
        )}
      </Empty>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          采集于 {formatDateTime(new Date(hardware.collectedAt).toISOString())}
        </Typography.Text>
        {onProbe && (
          <Button size="small" loading={probing} onClick={onProbe}>
            重新采集
          </Button>
        )}
      </div>

      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="操作系统">{hardware.os ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="内核">{hardware.kernel ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="CPU">{hardware.cpuModel ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="架构 / 逻辑核心">
          {hardware.arch ?? '—'} / {hardware.cpuLogical ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="内存">
          {formatGb(hardware.memTotalMb, 1)}
          {hardware.memAvailableMb != null && (
            <span style={{ color: '#64748b' }}>（可用 {formatGb(hardware.memAvailableMb, 1)}）</span>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="NVIDIA 驱动 / CUDA">
          {[hardware.driverVersion, hardware.cudaVersion].filter(Boolean).join(' / ') || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="tmux">{hardware.tmuxVersion ?? '未安装'}</Descriptions.Item>
        <Descriptions.Item label="screen">{hardware.screenVersion ?? '未安装'}</Descriptions.Item>
        <Descriptions.Item label="git">{hardware.gitVersion ?? '未安装'}</Descriptions.Item>
        <Descriptions.Item label="登录用户 / HOME">
          {hardware.whoami ?? '—'} / <span className="mono">{hardware.home ?? '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Shell">{hardware.shell || '—'}</Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Text strong>GPU</Typography.Text>
        {hardware.gpuList && hardware.gpuList.length > 0 ? (
          <Table
            style={{ marginTop: 8 }}
            size="small"
            pagination={false}
            rowKey={(row) => row.index}
            dataSource={hardware.gpuList}
            columns={[
              { title: '#', dataIndex: 'index', width: 60 },
              { title: '型号', dataIndex: 'name' },
              {
                title: '显存',
                dataIndex: 'memoryTotalMb',
                width: 110,
                render: (value: number | null) => formatGb(value, 0),
              },
            ]}
          />
        ) : (
          <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>未检测到 NVIDIA GPU</div>
        )}
      </div>

      <div>
        <Typography.Text strong>磁盘</Typography.Text>
        {hardware.disks && hardware.disks.length > 0 ? (
          <Table
            style={{ marginTop: 8 }}
            size="small"
            pagination={false}
            rowKey={(row) => row.mount}
            dataSource={hardware.disks}
            columns={[
              { title: '挂载点', dataIndex: 'mount', render: (value: string) => <span className="mono">{value}</span> },
              { title: '总容量', dataIndex: 'sizeKb', width: 120, render: (value: number) => formatDiskGb(value) },
              { title: '可用', dataIndex: 'availKb', width: 120, render: (value: number) => formatDiskGb(value) },
            ]}
          />
        ) : (
          <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>未获取到磁盘信息</div>
        )}
      </div>

      <div>
        <Typography.Text strong>conda 环境</Typography.Text>
        <div style={{ marginTop: 8 }}>
          {hardware.condaEnvs && hardware.condaEnvs.length > 0 ? (
            <Space size={[4, 4]} wrap>
              {hardware.condaEnvs.map((env) => (
                <Tag key={env}>{env}</Tag>
              ))}
            </Space>
          ) : (
            <span style={{ fontSize: 12, color: '#64748b' }}>未检测到 conda</span>
          )}
        </div>
      </div>
    </Space>
  );
}