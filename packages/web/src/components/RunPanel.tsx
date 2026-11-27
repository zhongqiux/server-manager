import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import type {
  Caps,
  JobDTO,
  JobInput,
  JobLauncherPreference,
  RemoteSession,
  RemoteSessionTool,
  RemoteSessionWindow,
  TargetDTO,
} from '@sm/shared';
import { isJobActive, JOB_LAUNCHER_LABELS } from '@sm/shared';
import { ApiError } from '../api/client';
import { useCreateJob, useJobs, useStopJob } from '../api/jobs';
import { useRemoteSessions } from '../api/servers';
import JobStatusTag from './JobStatusTag';
import { formatDateTime, formatJobDuration } from '../utils/format';

const recentColumns: TableColumnsType<JobDTO> = [
  {
    title: '状态',
    dataIndex: 'status',
    width: 96,
    render: (_, job) => <JobStatusTag status={job.status} />,
  },
  {
    title: '任务',
    dataIndex: 'title',
    ellipsis: true,
  },
  {
    title: '方式',
    dataIndex: 'launcher',
    width: 96,
    render: (value: JobDTO['launcher']) => (value ? JOB_LAUNCHER_LABELS[value] : '—'),
  },
  {
    title: '退出码',
    dataIndex: 'exitCode',
    width: 72,
    render: (value: number | null) => <span className="mono">{value ?? '—'}</span>,
  },
  {
    title: '耗时',
    key: 'duration',
    width: 84,
    render: (_, job) => formatJobDuration(job),
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    width: 132,
    render: (value: string) => formatDateTime(value),
  },
];

const SHELL_COMMANDS = new Set([
  'bash',
  'zsh',
  'sh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
]);

type SessionChoice = 'new' | 'existing';
type WindowPlan = 'new_window' | 'existing_window';

function sessionRefOf(session: RemoteSession): string {
  return `${session.tool}::${session.name}`;
}

function windowIsBusy(window: RemoteSessionWindow, tool: RemoteSessionTool): boolean {
  if (tool !== 'tmux' || !window.currentCommand) return false;
  const base = (window.currentCommand.split('/').pop() ?? window.currentCommand).replace(/^-/, '');
  return !SHELL_COMMANDS.has(base);
}

export default function RunPanel({ target, caps }: { target: TargetDTO; caps?: Caps }) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const jobsQuery = useJobs({ targetId: target.id, limit: 5 }, 4000);
  const createMutation = useCreateJob();
  const stopMutation = useStopJob();

  const [command, setCommand] = useState(target.runCommand);
  const [title, setTitle] = useState('');
  const [syncFirst, setSyncFirst] = useState(target.syncMode === 'sftp');
  const [launcher, setLauncher] = useState<JobLauncherPreference>('auto');
  const [sessionChoice, setSessionChoice] = useState<SessionChoice>('new');
  const [windowPlan, setWindowPlan] = useState<WindowPlan>('new_window');
  const [sessionRef, setSessionRef] = useState<string | undefined>();
  const [existingWindowId, setExistingWindowId] = useState<string | undefined>();
  const [confirmBusyWindow, setConfirmBusyWindow] = useState(false);

  const sessionsQuery = useRemoteSessions(target.serverId, sessionChoice === 'existing');
  const sessions = sessionsQuery.data?.sessions ?? [];
  const selectedSession = sessions.find((item) => sessionRefOf(item) === sessionRef);
  const selectedWindow = selectedSession?.windows.find((item) => item.id === existingWindowId);
  const selectedWindowBusy = Boolean(
    selectedSession && selectedWindow && windowIsBusy(selectedWindow, selectedSession.tool),
  );

  useEffect(() => {
    setCommand(target.runCommand);
    setSyncFirst(target.syncMode === 'sftp');
    setTitle('');
    setLauncher('auto');
    setSessionChoice('new');
    setWindowPlan('new_window');
    setSessionRef(undefined);
    setExistingWindowId(undefined);
    setConfirmBusyWindow(false);
  }, [target.id, target.runCommand, target.syncMode]);

  useEffect(() => {
    if (sessionChoice !== 'existing') return;
    if (!sessionsQuery.data) return;
    const stillThere = sessionsQuery.data.sessions.some(
      (item) => sessionRefOf(item) === sessionRef,
    );
    if (stillThere) return;
    const first = sessionsQuery.data.sessions[0];
    setSessionRef(first ? sessionRefOf(first) : undefined);
  }, [sessionChoice, sessionsQuery.data, sessionRef]);

  useEffect(() => {
    setExistingWindowId(undefined);
    setConfirmBusyWindow(false);
  }, [sessionRef]);

  useEffect(() => {
    setConfirmBusyWindow(false);
  }, [existingWindowId]);

  const launcherOptions = [
    { value: 'auto' as const, label: '自动（tmux → screen → nohup）' },
    {
      value: 'tmux' as const,
      label: caps?.tmux === false ? 'tmux（未安装）' : 'tmux 会话',
      disabled: caps?.tmux === false,
    },
    {
      value: 'screen' as const,
      label: caps?.screen === false ? 'screen（未安装）' : 'screen 会话',
      disabled: caps?.screen === false,
    },
    { value: 'nohup' as const, label: 'nohup 后台' },
  ];

  const sessionOptions = sessions.map((item) => ({
    value: sessionRefOf(item),
    label: `${item.tool} · ${item.name}（${item.windows.length} 个窗口）`,
  }));

  const windowOptions = (selectedSession?.windows ?? []).map((item) => ({
    value: item.id,
    label: `${item.name || '未命名'}（#${item.index}）${item.active ? ' · 当前窗口' : ''}${
      item.currentCommand ? ` · ${item.currentCommand}` : ''
    }`,
    disabled: windowIsBusy(item, selectedSession?.tool ?? 'tmux'),
  }));

  const existingValid = Boolean(selectedSession) && (
    windowPlan === 'new_window' ||
    (Boolean(existingWindowId) && confirmBusyWindow && !selectedWindowBusy)
  );
  const sessionReady = sessionChoice === 'new' || existingValid;

  const jobs = jobsQuery.data ?? [];
  const activeJob = jobs.find((job) => isJobActive(job.status));

  const run = async (): Promise<void> => {
    const payload: JobInput = {
      targetId: target.id,
      command: command.trim() === target.runCommand.trim() ? undefined : command,
      syncFirst,
      title: title.trim() || undefined,
    };
    if (sessionChoice === 'new') {
      payload.sessionMode = 'new';
      payload.launcher = launcher;
    } else if (selectedSession) {
      payload.sessionMode = windowPlan;
      payload.launcher = selectedSession.tool;
      payload.sessionName = selectedSession.name;
      if (windowPlan === 'existing_window' && selectedWindow) {
        payload.windowId = selectedWindow.id;
        payload.windowName = selectedWindow.name || undefined;
      }
    }

    try {
      const job = await createMutation.mutateAsync(payload);
      message.success('任务已创建，正在调度');
      navigate(`/jobs/${job.id}`);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('任务创建失败');
    }
  };

  const stop = async (): Promise<void> => {
    if (!activeJob) return;
    try {
      await stopMutation.mutateAsync({ id: activeJob.id });
      message.info('已发送停止请求');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('停止失败');
    }
  };

  const warnings = sessionsQuery.data?.warnings ?? [];
  const toolsInfo = sessionsQuery.data?.tools;

  return (
    <Card
      size="small"
      title="运行任务"
      extra={
        activeJob && (
          <Space size={8}>
            <Button size="small" type="link" onClick={() => navigate(`/jobs/${activeJob.id}`)}>
              查看运行中任务
            </Button>
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={stopMutation.isPending}
              onClick={() => void stop()}
            >
              停止
            </Button>
          </Space>
        )
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {activeJob && (
          <Alert
            type="info"
            showIcon
            message={`当前有任务在运行：${activeJob.title}`}
            description="同一目标可以并行启动多个任务；如需查看实时日志请进入任务详情。"
          />
        )}

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            运行命令（留空使用目标默认命令；会自动注入数据目录、GPU 设备与 conda 环境）
          </Typography.Text>
          <Input.TextArea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }}
            className="mono"
            style={{ marginTop: 6, fontSize: 12 }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            运行位置
          </Typography.Text>
          <Radio.Group
            value={sessionChoice}
            onChange={(event) => setSessionChoice(event.target.value as SessionChoice)}
            optionType="button"
            buttonStyle="solid"
            disabled={createMutation.isPending}
            options={[
              { value: 'new', label: '新建独立会话' },
              { value: 'existing', label: '使用已有 tmux / screen 会话' },
            ]}
          />
        </div>

        {sessionChoice === 'new' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              运行方式
            </Typography.Text>
            <Select<JobLauncherPreference>
              value={launcher}
              onChange={(value) => setLauncher(value)}
              options={launcherOptions}
              style={{ width: 260 }}
              disabled={createMutation.isPending}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              tmux / screen 会保持远程会话，断开 SSH 不会中断任务
            </Typography.Text>
          </div>
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={8} align="center">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                远程会话
              </Typography.Text>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={
                  sessionsQuery.isLoading ? '正在读取远程会话…' : '选择 tmux 或 screen 会话'
                }
                value={selectedSession ? sessionRef : undefined}
                onChange={(value) => setSessionRef(value)}
                options={sessionOptions}
                style={{ width: 360 }}
                loading={sessionsQuery.isLoading}
                disabled={createMutation.isPending || sessions.length === 0}
                notFoundContent="未发现会话"
              />
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={sessionsQuery.isFetching}
                onClick={() => void sessionsQuery.refetch()}
              >
                刷新
              </Button>
              {toolsInfo && (
                <Space size={4} wrap>
                  <Tag color={toolsInfo.tmux ? 'green' : 'default'}>
                    tmux {toolsInfo.tmux ? '可用' : '未安装'}
                  </Tag>
                  <Tag color={toolsInfo.screen ? 'green' : 'default'}>
                    screen {toolsInfo.screen ? '可用' : '未安装'}
                  </Tag>
                </Space>
              )}
            </Space>

            {sessionsQuery.isError && (
              <Alert
                type="error"
                showIcon
                message="获取远程会话失败"
                description={
                  sessionsQuery.error instanceof Error
                    ? sessionsQuery.error.message
                    : '请检查服务器连接后重试'
                }
                action={
                  <Button size="small" onClick={() => void sessionsQuery.refetch()}>
                    重试
                  </Button>
                }
              />
            )}

            {warnings.length > 0 && (
              <Alert type="warning" showIcon message={warnings.join('；')} />
            )}

            {sessionsQuery.isSuccess && sessions.length === 0 && (
              <Alert
                type="info"
                showIcon
                message="远程没有可用的 tmux / screen 会话"
                description="可在服务器上先创建会话，或改回“新建独立会话”由本工具自动创建。"
              />
            )}

            {selectedSession && (
              <>
                <Space wrap size={12} align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    窗口方式
                  </Typography.Text>
                  <Radio.Group
                    value={windowPlan}
                    onChange={(event) => setWindowPlan(event.target.value as WindowPlan)}
                    disabled={createMutation.isPending}
                    options={[
                      { value: 'new_window', label: '在会话中新开窗口（推荐）' },
                      { value: 'existing_window', label: '使用已有窗口' },
                    ]}
                  />
                </Space>

                {windowPlan === 'new_window' ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    将在 {selectedSession.tool} 会话「{selectedSession.name}」中新建一个独立窗口运行任务；
                    任务结束后只清理本工具新建的窗口，不会关闭该会话。
                  </Typography.Text>
                ) : (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space wrap size={8} align="center">
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="选择已有窗口"
                        value={existingWindowId}
                        onChange={(value) => setExistingWindowId(value)}
                        options={windowOptions}
                        style={{ width: 420 }}
                        disabled={createMutation.isPending}
                      />
                      {selectedWindow?.currentCommand && (
                        <Tag color={selectedWindowBusy ? 'red' : 'blue'}>
                          前台：{selectedWindow.currentCommand}
                        </Tag>
                      )}
                    </Space>
                    <Alert
                      type="warning"
                      showIcon
                      message="命令将直接输入到所选窗口，可能影响窗口中现有的内容"
                      description={
                        selectedSession.tool === 'tmux'
                          ? '仅当窗口前台是 shell 时才允许注入；请确认窗口空闲。任务结束或停止时不会关闭该窗口。'
                          : 'screen 无法可靠检测窗口内的前台命令，请务必确认窗口空闲。任务结束或停止时不会关闭该窗口。'
                      }
                    />
                    {selectedWindowBusy && (
                      <Alert
                        type="error"
                        showIcon
                        message={`该窗口正在运行「${selectedWindow?.currentCommand ?? ''}」，请选择空闲窗口或改用新开窗口`}
                      />
                    )}
                    <Checkbox
                      checked={confirmBusyWindow}
                      onChange={(event) => setConfirmBusyWindow(event.target.checked)}
                    >
                      我确认该窗口当前空闲，允许向其中输入任务命令
                    </Checkbox>
                  </Space>
                )}
              </>
            )}
          </Space>
        )}

        <Space wrap size={16}>
          <Input
            placeholder="任务标题（可选）"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            style={{ width: 240 }}
            maxLength={200}
          />
          <Checkbox
            checked={syncFirst}
            disabled={target.syncMode !== 'sftp' || createMutation.isPending}
            onChange={(event) => setSyncFirst(event.target.checked)}
          >
            运行前先同步代码
          </Checkbox>
          {target.syncMode !== 'sftp' && (
            <Tag color="purple" style={{ marginInlineEnd: 0 }}>
              Git 模式暂不支持运行前同步
            </Tag>
          )}
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={createMutation.isPending}
            disabled={!command.trim() || !sessionReady || selectedWindowBusy}
            onClick={() => void run()}
          >
            运行
          </Button>
          {!sessionReady && command.trim() && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {sessionChoice === 'existing' ? '请先选择可用的远程会话与窗口方式' : ''}
            </Typography.Text>
          )}
        </Space>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最近任务
          </Typography.Text>
          <Table
            rowKey="id"
            size="small"
            style={{ marginTop: 6 }}
            columns={recentColumns}
            dataSource={jobs}
            pagination={false}
            onRow={(job) => ({
              onClick: () => navigate(`/jobs/${job.id}`),
              style: { cursor: 'pointer' },
            })}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有运行记录" />,
            }}
          />
        </div>
      </Space>
    </Card>
  );
}