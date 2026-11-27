import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import type { JobDTO, JobStatus } from '@sm/shared';
import { JOB_LAUNCHER_LABELS, JOB_STATUSES, jobStatusLabel } from '@sm/shared';
import { useJobs } from '../../api/jobs';
import { useProjects } from '../../api/projects';
import JobStatusTag from '../../components/JobStatusTag';
import { formatBytes, formatDateTime, formatJobDuration } from '../../utils/format';

type StatusFilter = 'all' | 'active' | JobStatus;

const columns: TableColumnsType<JobDTO> = [
  {
    title: '任务',
    dataIndex: 'title',
    render: (title: string, job) => (
      <div>
        <Typography.Text strong>{title}</Typography.Text>
        {job.error && (
          <div>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {job.error}
            </Typography.Text>
          </div>
        )}
      </div>
    ),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    render: (status: JobStatus) => <JobStatusTag status={status} />,
  },
  {
    title: '项目 / 目标',
    key: 'scope',
    width: 200,
    render: (_, job) => (
      <div>
        <div>{job.projectName ?? '—'}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {job.targetLabel || job.serverName || '—'}
        </Typography.Text>
      </div>
    ),
  },
  {
    title: '服务器',
    dataIndex: 'serverName',
    width: 140,
    render: (value: string | undefined) => value ?? '—',
  },
  {
    title: '退出码',
    dataIndex: 'exitCode',
    width: 80,
    render: (value: number | null) => <span className="mono">{value ?? '—'}</span>,
  },
  {
    title: '运行方式',
    dataIndex: 'launcher',
    width: 90,
    render: (value: JobDTO['launcher']) =>
      value ? <Tag style={{ marginInlineEnd: 0 }}>{JOB_LAUNCHER_LABELS[value]}</Tag> : '—',
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    width: 140,
    render: (value: string) => formatDateTime(value),
  },
  {
    title: '耗时',
    key: 'duration',
    width: 88,
    render: (_, job) => formatJobDuration(job),
  },
  {
    title: '日志',
    key: 'logBytes',
    width: 76,
    render: (_, job) => formatBytes(job.logBytes),
  },
];

export default function JobsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const projectsQuery = useProjects();

  const filter =
    statusFilter === 'all'
      ? { projectId, limit: 200 }
      : statusFilter === 'active'
        ? { projectId, active: true, limit: 200 }
        : { projectId, status: statusFilter, limit: 200 };

  const jobsQuery = useJobs(filter, 4000);
  const jobs = jobsQuery.data ?? [];
  const activeCount = jobs.filter((job) =>
    ['pending', 'syncing', 'starting', 'running'].includes(job.status),
  ).length;

  return (
    <div>
      <div className="sm-page-header">
        <div>
          <h1 className="sm-page-title">任务</h1>
          <div className="sm-page-subtitle">实验运行历史、实时日志与退出码</div>
        </div>
        <Space wrap>
          {activeCount > 0 && <Tag color="processing">{activeCount} 个运行中</Tag>}
          <Select
            allowClear
            placeholder="按项目筛选"
            style={{ width: 180 }}
            value={projectId}
            onChange={(value) => setProjectId(value)}
            options={(projectsQuery.data ?? []).map((project) => ({
              value: project.id,
              label: project.name,
            }))}
          />
          <Select
            style={{ width: 140 }}
            value={statusFilter}
            onChange={(value) => setStatusFilter(value)}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'active', label: '运行中' },
              ...JOB_STATUSES.map((status) => ({ value: status, label: jobStatusLabel(status) })),
            ]}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={jobsQuery.isFetching}
            onClick={() => void jobsQuery.refetch()}
          >
            刷新
          </Button>
        </Space>
      </div>

      <Card size="small">
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={jobs}
          loading={jobsQuery.isLoading}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          onRow={(job) => ({
            onClick: () => navigate(`/jobs/${job.id}`),
            style: { cursor: 'pointer' },
          })}
          locale={{
            emptyText: (
              <Empty
                image={<PlayCircleOutlined style={{ fontSize: 44, color: '#94a3b8' }} />}
                styles={{ image: { height: 60 } }}
                description={
                  <Typography.Text type="secondary">
                    还没有任务：在目标工作台里填写命令并运行第一项实验
                  </Typography.Text>
                }
              />
            ),
          }}
        />
      </Card>
    </div>
  );
}