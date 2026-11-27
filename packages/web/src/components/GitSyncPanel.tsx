import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import {
  CloudUploadOutlined,
  DiffOutlined,
  GitlabOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type {
  GitRepoState,
  GitTargetState,
  SyncRunEvent,
  SyncRunStatus,
  TargetDTO,
} from '@sm/shared';
import { ApiError } from '../api/client';
import {
  syncKeys,
  useCancelSync,
  useStartSync,
  useSyncRun,
  useSyncRunEvents,
  useSyncRuns,
} from '../api/sync';
import { useDetectGitTarget, useTargets } from '../api/targets';
import SyncHistoryTable from './SyncHistoryTable';
import SyncStatusTag from './SyncStatusTag';
import { formatClock, formatDateTime } from '../utils/format';

type ConsoleLine = { level: 'info' | 'warn' | 'error'; message: string; ts: number };

const targetStateMeta: Record<GitTargetState['state'], { color: string; label: string }> = {
  missing: { color: 'default', label: '目录不存在' },
  empty: { color: 'blue', label: '空目录' },
  nonempty: { color: 'warning', label: '非空且非 Git 仓库' },
  repo: { color: 'success', label: 'Git 仓库' },
  error: { color: 'error', label: '读取失败' },
};

const actionMeta: Record<string, string> = {
  reported: '仅检查，未写入目标机',
  cloned: '目标机已克隆中心仓库',
  fast_forward: '目标机已快进更新',
  up_to_date: '目标机已是最新',
};

const consoleStyle: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  maxHeight: 280,
  overflow: 'auto',
  background: '#101418',
  color: '#d7dde3',
  borderRadius: 4,
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

function redactGitUrl(url: string): string {
  return url.replace(/\/\/([^/@\s]+)@/g, (match, auth: string) =>
    auth.includes(':') ? `//${auth.split(':')[0] ?? ''}:****@` : match,
  );
}

function RepoStateBlock({ title, state }: { title: string; state: GitRepoState }) {
  return (
    <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
      <Descriptions.Item label={title}>
        <Space size={4} wrap>
          <Tag color={state.isRepo ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
            {state.available ? (state.isRepo ? 'Git 仓库' : '非 Git 仓库') : '未安装 git'}
          </Tag>
          {state.branch && (
            <Tag style={{ marginInlineEnd: 0 }}>{state.branch}</Tag>
          )}
          {state.detached && (
            <Tag color="error" style={{ marginInlineEnd: 0 }}>
              detached HEAD
            </Tag>
          )}
          {state.head && (
            <Typography.Text code style={{ fontSize: 12 }}>
              {state.head}
            </Typography.Text>
          )}
          {state.ahead != null && state.ahead > 0 && (
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              领先中心 {state.ahead} 个提交
            </Tag>
          )}
          {state.behind != null && state.behind > 0 && (
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              落后中心 {state.behind} 个提交
            </Tag>
          )}
          {state.dirtyCount > 0 ? (
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              {state.dirtyCount} 个未提交变更
            </Tag>
          ) : state.isRepo ? (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              工作区干净
            </Tag>
          ) : null}
        </Space>
        {state.dirty.length > 0 && (
          <pre style={{ ...consoleStyle, maxHeight: 120, marginTop: 6 }}>
            {state.dirty.slice(0, 8).join('\n')}
            {state.dirtyCount > 8 ? `\n… 其余 ${state.dirtyCount - 8} 项` : ''}
          </pre>
        )}
        {state.warnings.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {state.warnings.map((warning) => (
              <Typography.Text key={warning} type="warning" style={{ display: 'block', fontSize: 12 }}>
                {warning}
              </Typography.Text>
            ))}
          </div>
        )}
      </Descriptions.Item>
    </Descriptions>
  );
}

export default function GitSyncPanel({ target }: { target: TargetDTO }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const runsQuery = useSyncRuns({ targetId: target.id, limit: 8 });
  const targetsQuery = useTargets({ projectId: target.projectId });
  const startMutation = useStartSync();
  const cancelMutation = useCancelSync();
  const detectMutation = useDetectGitTarget();

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<SyncRunStatus | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const consoleRef = useRef<HTMLPreElement | null>(null);

  const activeQuery = useSyncRun(activeRunId ?? undefined, Boolean(activeRunId));
  const inspectQuery = useSyncRun(inspectId ?? undefined);

  const cfg = target.syncConfig;
  const remoteUrl = cfg.remoteUrl ?? '';
  const branch = cfg.branch || 'main';
  const sourceKind = cfg.sourceKind ?? 'local';
  const sourceTargetId = cfg.sourceTargetId ?? null;
  const sourceTarget = (targetsQuery.data ?? []).find((item) => item.id === sourceTargetId);
  const sourceLabel = sourceTarget
    ? `${sourceTarget.label || sourceTarget.serverName || '目标'}（${sourceTarget.remoteCodeDir}）`
    : '未选择';

  useSyncRunEvents(activeRunId, (event: SyncRunEvent) => {
    if (event.type === 'status') {
      setLiveStatus(event.status);
    } else if (event.type === 'log') {
      setLines((prev) =>
        [...prev, { level: event.level, message: event.message, ts: event.ts }].slice(-1000),
      );
    } else if (event.type === 'done') {
      if (event.status === 'done') {
        message.success('Git 同步完成');
      } else if (event.status === 'canceled') {
        message.warning('Git 同步已取消');
      } else {
        message.error(event.error ?? 'Git 同步失败');
      }
      setActiveRunId(null);
      setLiveStatus(null);
      setInspectId(event.runId);
      void queryClient.invalidateQueries({ queryKey: syncKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['targets'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });

  const latest = runsQuery.data?.[0];
  const baseRun = inspectQuery.data ?? activeQuery.data ?? latest;
  const gitSummary = baseRun?.git ?? null;
  const status = activeRunId ? (liveStatus ?? baseRun?.status) : baseRun?.status;
  const busy = Boolean(activeRunId) || startMutation.isPending;
  const detect = detectMutation.data;

  const consoleText = useMemo(() => {
    if (activeRunId) {
      return lines
        .map((line) => {
          const level = line.level === 'info' ? '' : ` [${line.level}]`;
          return `${formatClock(new Date(line.ts).toISOString())}${level} ${line.message}`;
        })
        .join('\n');
    }
    return baseRun?.outputTail ?? '';
  }, [activeRunId, lines, baseRun]);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleText]);

  const start = async (dryRun: boolean): Promise<void> => {
    setInspectId(null);
    setLines([]);
    setLiveStatus(null);
    try {
      const run = await startMutation.mutateAsync({ targetId: target.id, dryRun });
      setActiveRunId(run.id);
      setLiveStatus(run.status);
      message.info(dryRun ? 'Git 差异检查已开始' : 'Git 同步已开始');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('Git 同步启动失败');
    }
  };

  const cancel = async (): Promise<void> => {
    if (!activeRunId) return;
    try {
      await cancelMutation.mutateAsync(activeRunId);
      message.info('已请求取消');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('取消失败');
    }
  };

  return (
    <Card
      size="small"
      title="代码同步（Git 中心仓库）"
      extra={
        <Space wrap>
          <Button
            size="small"
            icon={<GitlabOutlined />}
            loading={detectMutation.isPending}
            disabled={busy}
            onClick={() => detectMutation.mutate(target.id)}
          >
            检测仓库
          </Button>
          <Button
            size="small"
            icon={<DiffOutlined />}
            loading={busy && startMutation.isPending}
            disabled={busy}
            onClick={() => void start(true)}
          >
            检查差异
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<CloudUploadOutlined />}
            loading={busy && startMutation.isPending}
            disabled={busy}
            onClick={() => void start(false)}
          >
            Git 同步
          </Button>
          {activeRunId && (
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={cancelMutation.isPending}
              onClick={() => void cancel()}
            >
              取消
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {!remoteUrl && (
          <Alert
            type="warning"
            showIcon
            message="尚未配置中心仓库地址"
            description="请先在「编辑目标」中填写 Git 仓库地址（如 ssh://git@host/repo.git 或 https://host/repo.git）。"
          />
        )}

        {sourceKind === 'target' && (
          <Alert
            type="info"
            showIcon
            message="提交源为其他服务器"
            description="提交与推送将在源服务器上执行，源服务器需自备 Git 凭据；成功后本地项目目录可能落后于中心仓库。"
          />
        )}

        <Descriptions size="small" column={1}>
          <Descriptions.Item label="中心仓库">
            <Typography.Text code>{remoteUrl ? redactGitUrl(remoteUrl) : '—'}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="分支">{branch}</Descriptions.Item>
          <Descriptions.Item label="提交源">
            {sourceKind === 'local' ? '本地项目目录' : sourceLabel}
          </Descriptions.Item>
          <Descriptions.Item label="自动提交">
            {cfg.autoCommitOnSource === false ? '关闭（仅推送已有提交）' : '开启'}
          </Descriptions.Item>
          <Descriptions.Item label="缺失时克隆">
            {cfg.cloneIfMissing === false ? '关闭' : '开启（目标目录缺失/为空时自动 clone）'}
          </Descriptions.Item>
        </Descriptions>

        {detectMutation.isPending && (
          <Space size={8}>
            <Spin size="small" />
            <Typography.Text type="secondary">正在检测本地/源服务器/目标机仓库状态…</Typography.Text>
          </Space>
        )}

        {detect && (
          <div>
            {detect.error ? (
              <Alert type="error" showIcon message={detect.error} />
            ) : (
              <Alert
                type="success"
                showIcon
                message="仓库状态检测完成"
                description={`中心仓库 ${detect.remoteUrl} · 分支 ${detect.branch}`}
              />
            )}
            {detect.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                message="注意事项"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {detect.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {detect.local && <RepoStateBlock title="本地仓库" state={detect.local} />}
            {detect.source && <RepoStateBlock title="提交源（目标服务器）" state={detect.source} />}
            {detect.target && (
              <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
                <Descriptions.Item label="目标机代码目录">
                  <Space size={4} wrap>
                    <Tag
                      color={targetStateMeta[detect.target.state].color}
                      style={{ marginInlineEnd: 0 }}
                    >
                      {targetStateMeta[detect.target.state].label}
                    </Tag>
                    {detect.target.branch && (
                      <Tag style={{ marginInlineEnd: 0 }}>{detect.target.branch}</Tag>
                    )}
                    {detect.target.head && (
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {detect.target.head}
                      </Typography.Text>
                    )}
                    {detect.target.dirtyCount > 0 && (
                      <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                        {detect.target.dirtyCount} 个未提交变更
                      </Tag>
                    )}
                  </Space>
                  {detect.target.reason && (
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                      {detect.target.reason}
                    </Typography.Text>
                  )}
                  {detect.target.dirty.length > 0 && (
                    <pre style={{ ...consoleStyle, maxHeight: 120, marginTop: 6 }}>
                      {detect.target.dirty.slice(0, 8).join('\n')}
                      {detect.target.dirtyCount > 8
                        ? `\n… 其余 ${detect.target.dirtyCount - 8} 项`
                        : ''}
                    </pre>
                  )}
                </Descriptions.Item>
              </Descriptions>
            )}
          </div>
        )}

        {activeRunId && (
          <Space size={8} wrap>
            <SyncStatusTag status={status ?? 'pending'} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              实时输出见下方控制台
            </Typography.Text>
          </Space>
        )}

        {!activeRunId && baseRun?.error && <Alert type="error" showIcon message={baseRun.error} />}

        {gitSummary && (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="本次结果">
              <Space size={4} wrap>
                {baseRun?.dryRun ? (
                  <Tag style={{ marginInlineEnd: 0 }}>差异检查</Tag>
                ) : gitSummary.committed ? (
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    已提交 {gitSummary.committed.slice(0, 7)}
                  </Tag>
                ) : (
                  <Tag style={{ marginInlineEnd: 0 }}>无新提交</Tag>
                )}
                <Tag
                  color={gitSummary.pushed ? 'success' : 'default'}
                  style={{ marginInlineEnd: 0 }}
                >
                  {gitSummary.pushed ? '已推送中心仓库' : '未推送'}
                </Tag>
                {gitSummary.ahead != null && gitSummary.ahead > 0 && (
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                    领先 {gitSummary.ahead} 个提交
                  </Tag>
                )}
                {gitSummary.targetAction && (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    {actionMeta[gitSummary.targetAction] ?? gitSummary.targetAction}
                  </Tag>
                )}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="中心仓库">
              <Typography.Text code>{gitSummary.remoteUrl}</Typography.Text> · 分支{' '}
              {gitSummary.branch} · 源{' '}
              {gitSummary.sourceKind === 'local' ? '本地' : '其他服务器'}
            </Descriptions.Item>
            {gitSummary.warnings.length > 0 && (
              <Descriptions.Item label="警告">
                {gitSummary.warnings.map((warning) => (
                  <Typography.Text
                    key={warning}
                    type="warning"
                    style={{ display: 'block', fontSize: 12 }}
                  >
                    {warning}
                  </Typography.Text>
                ))}
              </Descriptions.Item>
            )}
          </Descriptions>
        )}

        {inspectId && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              正在查看历史记录 {formatDateTime(baseRun?.startedAt)}
            </Typography.Text>
            <Button type="link" size="small" onClick={() => setInspectId(null)}>
              返回最新
            </Button>
          </div>
        )}

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {activeRunId ? '实时输出' : '运行输出'}
          </Typography.Text>
          {consoleText ? (
            <pre ref={consoleRef} style={{ ...consoleStyle, marginTop: 6 }}>
              {consoleText}
            </pre>
          ) : (
            <div style={{ marginTop: 6 }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  activeRunId ? '等待输出…' : '暂无输出：可先「检测仓库」或「检查差异」了解现状。'
                }
              />
            </div>
          )}
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最近同步
          </Typography.Text>
          <SyncHistoryTable
            runs={runsQuery.data ?? []}
            disabled={Boolean(activeRunId)}
            onInspect={(run) => setInspectId(run.id)}
          />
        </div>
      </Space>
    </Card>
  );
}