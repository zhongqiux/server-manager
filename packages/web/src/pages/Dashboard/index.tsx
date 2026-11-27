import { Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CloudServerOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { JobDTO, SyncRunDTO } from '@sm/shared';
import { useDashboard } from '../../api/dashboard';
import { useHealth } from '../../api/health';
import GpuCard from '../../components/GpuCard';
import GpuDetailTable, { ourPidsByServer } from '../../components/GpuDetailTable';
import JobStatusTag from '../../components/JobStatusTag';
import SyncStatusTag from '../../components/SyncStatusTag';
import { formatDateTime, formatDurationMs, formatJobDuration } from '../../utils/format';

const jobColumns: TableColumnsType<JobDTO> = [
  {
    title: '任务',
    key: 'title',
    render: (_, job) => (
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {job.title}
        </Typography.Text>
        <div className="text-muted" style={{ fontSize: 12 }}>
          {job.projectName ?? '—'} → {job.targetLabel ?? job.serverName ?? '—'}
        </div>
      </div>
    ),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (_, job) => <JobStatusTag status={job.status} />,
  },
  {
    title: '服务器',
    dataIndex: 'serverName',
    width: 130,
    render: (value: string | undefined) => value ?? '—',
  },
  {
    title: '已运行',
    key: 'elapsed',
    width: 90,
    render: (_, job) => formatJobDuration(job),
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    width: 130,
    render: (value: string) => formatDateTime(value),
  },
];

const syncColumns: TableColumnsType<SyncRunDTO> = [
  {
    title: '开始时间',
    dataIndex: 'startedAt',
    width: 130,
    render: (value: string) => formatDateTime(value),
  },
  {
    title: '目标',
    key: 'dest',
    render: (_, run) => run.plan?.dest.label ?? '—',
  },
  {
    title: '方式',
    dataIndex: 'dryRun',
    width: 100,
    render: (dryRun: boolean, run) => (
      <Space size={4}>
        <Tag style={{ marginInlineEnd: 0 }}>{dryRun ? '检查' : '同步'}</Tag>
        {run.direction === 'target_to_target' && (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            中转
          </Tag>
        )}
      </Space>
    ),
  },
  {
    title: '结果',
    dataIndex: 'status',
    width: 80,
    render: (status) => <SyncStatusTag status={status} />,
  },
  {
    title: '变更',
    key: 'changes',
    width: 110,
    render: (_, run) =>
      run.counts ? `+${run.counts.add} / ~${run.counts.updateSize + run.counts.updateMtime}` : '—',
  },
  {
    title: '耗时',
    key: 'duration',
    width: 80,
    render: (_, run) =>
      run.finishedAt
        ? formatDurationMs(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
        : '—',
  },
];

export default function DashboardPage() {
  const navigate = useNavigate();
  const dashboardQuery = useDashboard();
  const demo = useHealth().data?.demo === true;
  const data = dashboardQuery.data;

  const header = (
    <div className="sm-page-header">
      <div>
        <h1 className="sm-page-title">总览</h1>
        <div className="sm-page-subtitle">所有 GPU 服务器、运行中任务与最近同步的一屏视图</div>
      </div>
      <Button
        icon={<ReloadOutlined />}
        loading={dashboardQuery.isFetching && !dashboardQuery.isLoading}
        onClick={() => void dashboardQuery.refetch()}
      >
        刷新
      </Button>
    </div>
  );

  if (dashboardQuery.isError) {
    return (
      <div>
        {header}
        <Alert
          type="error"
          showIcon
          message="总览数据加载失败"
          description={dashboardQuery.error instanceof Error ? dashboardQuery.error.message : undefined}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        {header}
        <Card loading />
      </div>
    );
  }

  if (data.stats.serversTotal === 0) {
    return (
      <div>
        {header}
        <Card>
          <Empty
            image={<CloudServerOutlined style={{ fontSize: 48, color: '#94a3b8' }} />}
            styles={{ image: { height: 64 } }}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text strong>还没有服务器</Typography.Text>
                <Typography.Text type="secondary">
                  ① 添加 GPU 服务器 → ② 创建项目并绑定服务器 → ③ 同步代码并运行实验
                </Typography.Text>
                {!demo && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    想先体验完整界面？设置环境变量 <Typography.Text code>SM_DEMO=1</Typography.Text>{' '}
                    后重启即可载入合成演示数据（启动命令见 README「演示模式」）。
                  </Typography.Text>
                )}
              </Space>
            }
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/servers')}>
              添加服务器
            </Button>
          </Empty>
        </Card>
      </div>
    );
  }

  const { stats } = data;
  const pidsByServer = ourPidsByServer(data.runningJobs);

  return (
    <div>
      {header}

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Row gutter={[12, 12]}>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="在线服务器"
                value={stats.serversOnline}
                suffix={`/ ${stats.serversTotal}`}
                prefix={<CloudServerOutlined />}
                valueStyle={{ fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="空闲 GPU"
                value={stats.gpuIdle}
                suffix={`/ ${stats.gpuTotal}`}
                prefix={<ThunderboltOutlined />}
                valueStyle={{ fontSize: 22, color: stats.gpuIdle > 0 ? '#16a34a' : undefined }}
              />
            </Card>
          </Col>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="运行中任务"
                value={stats.runningJobs}
                prefix={<PlayCircleOutlined />}
                valueStyle={{ fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} lg={6}>
            <Card size="small">
              <Statistic
                title="今日同步"
                value={stats.syncsToday}
                prefix={<SyncOutlined />}
                valueStyle={{ fontSize: 22 }}
              />
            </Card>
          </Col>
        </Row>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Typography.Text strong>GPU 卡片墙</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              实时数据经全局 SSE 推送 · 空闲 = 无计算进程且利用率、显存均低
            </Typography.Text>
          </div>
          <Row gutter={[12, 12]}>
            {data.servers.map((server) => (
              <Col key={server.id} xs={24} md={12} xl={8}>
                <GpuCard server={server} ourPids={pidsByServer.get(server.id) ?? new Set<number>()} />
              </Col>
            ))}
          </Row>
        </div>

        <Card
          size="small"
          title="运行中的任务"
          extra={
            <Button type="link" size="small" onClick={() => navigate('/jobs')}>
              全部任务
            </Button>
          }
        >
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            columns={jobColumns}
            dataSource={data.runningJobs}
            onRow={(job) => ({
              onClick: () => navigate(`/jobs/${job.id}`),
              style: { cursor: 'pointer' },
            })}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有运行中的任务" /> }}
          />
        </Card>

        <Card
          size="small"
          title="最近同步"
          extra={
            <Button type="link" size="small" onClick={() => navigate('/projects')}>
              去项目页发起同步
            </Button>
          }
        >
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            columns={syncColumns}
            dataSource={data.recentSyncs}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无同步记录" /> }}
          />
        </Card>

        <Card size="small" title="GPU 明细" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>计算进程含「本工具任务」徽标</Typography.Text>}>
          <GpuDetailTable servers={data.servers} runningJobs={data.runningJobs} />
        </Card>
      </Space>
    </div>
  );
}