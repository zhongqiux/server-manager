import { Alert, Card, Space, Tag, Typography } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { ServerDTO } from '@sm/shared';
import GpuBar, { formatGib } from './GpuBar';
import ServerStatusTag from './ServerStatusTag';

function ourProcessCount(server: ServerDTO, pids: Set<number>): number {
  if (!server.gpu) return 0;
  let count = 0;
  for (const gpu of server.gpu.gpus) {
    for (const proc of gpu.processes) if (pids.has(proc.pid)) count += 1;
  }
  return count;
}

export default function GpuCard({
  server,
  ourPids = new Set<number>(),
}: {
  server: ServerDTO;
  ourPids?: Set<number>;
}) {
  const gpu = server.gpu;
  const ourCount = ourProcessCount(server, ourPids);

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space size={8} wrap>
          <Link to={`/servers/${server.id}`} style={{ fontWeight: 500 }}>
            {server.name}
          </Link>
          <ServerStatusTag status={server.status} />
          {server.tags.slice(0, 2).map((tag) => (
            <Tag key={tag} style={{ marginInlineEnd: 0 }}>
              {tag}
            </Tag>
          ))}
        </Space>
      }
      extra={
        gpu?.supported ? (
          <Space size={4}>
            {gpu.stale && <Tag color="default">离线快照</Tag>}
            <Tag color={gpu.idleCount > 0 ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
              空闲 {gpu.idleCount}/{gpu.gpus.length}
            </Tag>
          </Space>
        ) : null
      }
    >
      {!gpu && (
        <Typography.Text type="secondary">
          <Space size={6}>
            <LoadingOutlined />
            正在采集 GPU 状态…
          </Space>
        </Typography.Text>
      )}

      {gpu && !gpu.supported && (
        <Alert type="info" showIcon message={gpu.reason ?? '该服务器没有可用的 NVIDIA GPU'} />
      )}

      {gpu?.supported && (
        <div>
          {gpu.gpus.map((info, index) => (
            <div
              key={info.uuid || info.index}
              style={{
                paddingTop: index === 0 ? 0 : 10,
                marginTop: index === 0 ? 0 : 10,
                borderTop: index === 0 ? undefined : '1px solid #f1f5f9',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <Typography.Text ellipsis style={{ fontSize: 13 }}>
                  GPU {info.index} · {info.name}
                </Typography.Text>
                {info.idle ? (
                  <Tag color="success" style={{ marginInlineEnd: 0 }}>
                    可运行
                  </Tag>
                ) : (
                  <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                    {info.processes.length > 0 ? `${info.processes.length} 进程` : '占用'}
                  </Tag>
                )}
              </div>
              <GpuBar percent={info.memUsedPct} />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 12,
                  color: '#64748b',
                  marginTop: 2,
                }}
              >
                <span>
                  显存 {formatGib(info.memoryUsedMb)} / {formatGib(info.memoryTotalMb)}
                </span>
                <span>
                  利用率 {info.utilPercent != null ? `${info.utilPercent}%` : '—'} ·{' '}
                  {info.temperatureC != null ? `${info.temperatureC}°C` : '—'}
                </span>
              </div>
            </div>
          ))}
          {ourCount > 0 && (
            <div style={{ marginTop: 8 }}>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                本工具任务 {ourCount} 个进程
              </Tag>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}