import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Popconfirm,
  Result,
  Space,
  Spin,
  Timeline,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CloudServerOutlined,
  ExperimentOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { JobDTO, JobEventDTO } from '@sm/shared';
import { isJobActive, JOB_LAUNCHER_LABELS, JOB_SESSION_MODE_LABELS } from '@sm/shared';
import { ApiError } from '../../api/client';
import { useJob, useStopJob } from '../../api/jobs';
import JobStatusTag from '../../components/JobStatusTag';
import LogViewer from '../../components/LogViewer';
import { formatBytes, formatClock, formatDateTimeSec, formatJobDuration } from '../../utils/format';

function eventColor(kind: string, event: JobEventDTO): string {
  if (kind === 'status') {
    const to = (event.data as { to?: string } | null)?.to;
    if (to === 'failed' || to === 'lost' || to === 'start_failed' || to === 'sync_failed') return 'red';
    if (to === 'canceled') return 'orange';
    if (to === 'exited') return 'green';
    return 'blue';
  }
  if (kind === 'stop') return 'orange';
  if (kind === 'error') return 'red';
  if (kind === 'launch') return 'green';
  if (kind === 'sync') return 'purple';
  return 'gray';
}

export default function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const jobQuery = useJob(id, true);
  const stopMutation = useStopJob();

  if (jobQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }

  const job: JobDTO | undefined = jobQuery.data;
  if (jobQuery.isError || !job) {
    return (
      <Result
        status="404"
        title="任务不存在"
        subTitle="它可能已被删除"
        extra={
          <Button type="primary" onClick={() => navigate('/jobs')}>
            返回任务列表
          </Button>
        }
      />
    );
  }

  const active = isJobActive(job.status);
  const events = (job.events ?? []).slice().sort((a, b) => a.id - b.id);
  const stopHint =
    job.sessionMode === 'existing_window'
      ? '将向目标窗口发送 Ctrl-C，并只终止该任务的进程组；不会关闭会话或窗口。'
      : job.sessionMode === 'new_window'
        ? '将向任务窗口发送 Ctrl-C，必要时关闭本工具新建的窗口并终止进程组；不会关闭已有会话。'
        : '将依次尝试 Ctrl-C、关闭本工具新建的会话、终止进程组。';

  const stop = async (force: boolean): Promise<void> => {
    try {
      await stopMutation.mutateAsync({ id: job.id, force });
      message.info(force ? '已发送强制停止请求' : '已发送停止请求，按五步流程终止');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('停止失败');
    }
  };

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/jobs')} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 className="sm-page-title">{job.title}</h1>
              <JobStatusTag status={job.status} showBadge />
              {job.launcher && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {JOB_LAUNCHER_LABELS[job.launcher]}
                </Typography.Text>
              )}
            </div>
            <div className="sm-page-subtitle">
              {job.projectName} → {job.targetLabel || job.serverName} · 创建于 {formatDateTimeSec(job.createdAt)}
            </div>
          </div>
        </div>
        <Space wrap>
          <Button icon={<ExperimentOutlined />} onClick={() => navigate(`/projects/${job.projectId}`)}>
            项目
          </Button>
          <Button
            icon={<CloudServerOutlined />}
            onClick={() => navigate(`/projects/${job.projectId}/targets/${job.targetId}`)}
          >
            目标工作台
          </Button>
          {active && (
            <>
              <Popconfirm
                title="停止任务"
                description={stopHint}
                okText="停止"
                cancelText="取消"
                onConfirm={() => void stop(false)}
              >
                <Button icon={<StopOutlined />} loading={stopMutation.isPending}>
                  停止
                </Button>
              </Popconfirm>
              <Popconfirm
                title="强制停止"
                description="跳过优雅步骤，直接终止远程进程组。"
                okText="强制停止"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void stop(true)}
              >
                <Button danger icon={<ThunderboltOutlined />} loading={stopMutation.isPending}>
                  强制停止
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      </div>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {job.error && <Alert type={job.status === 'canceled' ? 'warning' : 'error'} showIcon message={job.error} />}

        <Card size="small" title="任务概况">
          <Descriptions column={{ xs: 1, md: 2, xl: 3 }} size="small">
            <Descriptions.Item label="状态">
              <JobStatusTag status={job.status} />
            </Descriptions.Item>
            <Descriptions.Item label="退出码">
              <span className="mono">{job.exitCode ?? '—'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="耗时">{formatJobDuration(job)}</Descriptions.Item>
            <Descriptions.Item label="项目">{job.projectName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="目标">{job.targetLabel ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="服务器">{job.serverName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="启动时间">{formatDateTimeSec(job.startedAt)}</Descriptions.Item>
            <Descriptions.Item label="结束时间">{formatDateTimeSec(job.finishedAt)}</Descriptions.Item>
            <Descriptions.Item label="最后探测">{formatDateTimeSec(job.lastSeenAt)}</Descriptions.Item>
            <Descriptions.Item label="运行方式">
              {job.launcher ? JOB_LAUNCHER_LABELS[job.launcher] : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="会话模式">
              {JOB_SESSION_MODE_LABELS[job.sessionMode]}
            </Descriptions.Item>
            <Descriptions.Item label="会话名称">
              <span className="mono">{job.sessionName ?? '—'}</span>
            </Descriptions.Item>
            {job.sessionMode !== 'new' && (
              <Descriptions.Item label="目标窗口">
                <span className="mono">
                  {job.windowName ?? '—'}
                  {job.windowId ? `（${job.windowId}）` : ''}
                </span>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="远程 PID / PGID">
              <span className="mono">
                {job.remotePid ?? '—'} / {job.remotePgid ?? '—'}
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="日志大小">{formatBytes(job.logBytes)}</Descriptions.Item>
            <Descriptions.Item label="日志路径" span={2}>
              <span className="mono" style={{ fontSize: 12 }}>
                {job.logPath ?? '—'}
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="脚本路径">
              <span className="mono" style={{ fontSize: 12 }}>
                {job.scriptPath ?? '—'}
              </span>
            </Descriptions.Item>
            {job.syncRunId && (
              <Descriptions.Item label="同步记录">
                <span className="mono" style={{ fontSize: 12 }}>
                  {job.syncRunId.slice(0, 8)}
                </span>
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>

        <Card size="small" title="实时日志">
          <LogViewer job={job} height={460} />
        </Card>

        <Card size="small" title="运行命令与脚本">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                实际执行命令
              </Typography.Text>
              <pre className="sm-code-block">{job.renderedCommand}</pre>
            </div>
            {job.scriptContent && (
              <Collapse
                size="small"
                items={[
                  {
                    key: 'script',
                    label: '查看远程执行脚本',
                    children: <pre className="sm-code-block">{job.scriptContent}</pre>,
                  },
                ]}
              />
            )}
          </Space>
        </Card>

        <Card size="small" title="状态时间线">
          {events.length === 0 ? (
            <Typography.Text type="secondary">暂无事件</Typography.Text>
          ) : (
            <Timeline
              style={{ marginTop: 8 }}
              items={events.map((event) => ({
                key: event.id,
                color: eventColor(event.kind, event),
                children: (
                  <div>
                    <span className="mono text-muted" style={{ fontSize: 12, marginRight: 8 }}>
                      {formatClock(event.ts)}
                    </span>
                    <Typography.Text>{event.message ?? event.kind}</Typography.Text>
                  </div>
                ),
              }))}
            />
          )}
        </Card>
      </Space>
    </div>
  );
}