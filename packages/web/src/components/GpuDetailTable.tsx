import { Empty, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import type { GpuInfo, JobDTO, ServerDTO } from '@sm/shared';
import GpuBar, { formatGib } from './GpuBar';

type Row = {
  key: string;
  server: ServerDTO;
  gpu: GpuInfo;
  ourPids: Set<number>;
};

export function ourPidsByServer(jobs: JobDTO[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const job of jobs) {
    if (job.remotePid == null) continue;
    const set = map.get(job.serverId) ?? new Set<number>();
    set.add(job.remotePid);
    map.set(job.serverId, set);
  }
  return map;
}

function processCell(gpu: GpuInfo, ourPids: Set<number>) {
  if (gpu.processes.length === 0) return <span className="text-muted">—</span>;
  return (
    <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
      {gpu.processes.map((proc) => (
        <Space key={`${proc.pid}-${proc.name}`} size={4} wrap>
          <span className="mono">{proc.pid}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: proc.name }}>
            {proc.name.length > 40 ? `${proc.name.slice(0, 40)}…` : proc.name}
          </Typography.Text>
          <span className="text-muted">{formatGib(proc.usedMemoryMb)}</span>
          {ourPids.has(proc.pid) && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              本工具任务
            </Tag>
          )}
        </Space>
      ))}
    </Space>
  );
}

export default function GpuDetailTable({
  servers,
  runningJobs = [],
  showServer = true,
}: {
  servers: ServerDTO[];
  runningJobs?: JobDTO[];
  showServer?: boolean;
}) {
  const pidsByServer = ourPidsByServer(runningJobs);
  const rows: Row[] = [];
  for (const server of servers) {
    if (!server.gpu?.supported) continue;
    const ourPids = pidsByServer.get(server.id) ?? new Set<number>();
    for (const gpu of server.gpu.gpus) {
      rows.push({ key: `${server.id}:${gpu.uuid || gpu.index}`, server, gpu, ourPids });
    }
  }

  const columns: TableColumnsType<Row> = [
    ...(showServer
      ? [
          {
            title: '服务器',
            key: 'server',
            width: 150,
            render: (_: unknown, row: Row) => (
              <Space direction="vertical" size={0}>
                <Link to={`/servers/${row.server.id}`}>{row.server.name}</Link>
                {row.server.gpu?.stale && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    离线快照
                  </Typography.Text>
                )}
              </Space>
            ),
          },
        ]
      : []),
    {
      title: 'GPU',
      key: 'gpu',
      width: 220,
      render: (_, row) => (
        <div>
          <Typography.Text style={{ fontSize: 13 }}>GPU {row.gpu.index}</Typography.Text>
          <div className="text-muted" style={{ fontSize: 12 }}>
            {row.gpu.name}
          </div>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 80,
      render: (_, row) =>
        row.gpu.idle ? (
          <Tag color="success" style={{ marginInlineEnd: 0 }}>
            空闲
          </Tag>
        ) : (
          <Tag color="processing" style={{ marginInlineEnd: 0 }}>
            占用
          </Tag>
        ),
    },
    {
      title: '显存',
      key: 'memory',
      width: 190,
      render: (_, row) => (
        <div>
          <GpuBar percent={row.gpu.memUsedPct} />
          <div className="text-muted" style={{ fontSize: 12 }}>
            {formatGib(row.gpu.memoryUsedMb)} / {formatGib(row.gpu.memoryTotalMb)}
          </div>
        </div>
      ),
    },
    {
      title: '利用率',
      key: 'util',
      width: 80,
      render: (_, row) => (row.gpu.utilPercent != null ? `${row.gpu.utilPercent}%` : '—'),
    },
    {
      title: '温度',
      key: 'temp',
      width: 80,
      render: (_, row) => {
        if (row.gpu.temperatureC == null) return '—';
        const hot = row.gpu.temperatureC >= 80;
        return <Tag color={hot ? 'red' : 'default'}>{row.gpu.temperatureC}°C</Tag>;
      },
    },
    {
      title: '功耗',
      key: 'power',
      width: 110,
      render: (_, row) => (
        <span className="text-muted" style={{ fontSize: 12 }}>
          {row.gpu.powerW != null ? `${Math.round(row.gpu.powerW)}` : '—'}
          {row.gpu.powerLimitW != null ? ` / ${Math.round(row.gpu.powerLimitW)} W` : row.gpu.powerW != null ? ' W' : ''}
        </span>
      ),
    },
    {
      title: '计算进程',
      key: 'processes',
      render: (_, row) => processCell(row.gpu, row.ourPids),
    },
  ];

  return (
    <Table
      size="small"
      rowKey="key"
      pagination={false}
      scroll={{ x: showServer ? 980 : 840 }}
      dataSource={rows}
      columns={columns}
      locale={{
        emptyText: (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 GPU 数据，订阅后会每 5 秒自动采集" />
        ),
      }}
    />
  );
}