import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  CloudUploadOutlined,
  DiffOutlined,
  StopOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import type { SyncPlan, SyncProgress, SyncRunEvent, SyncRunStatus, TargetDTO } from '@sm/shared';
import { ApiError } from '../api/client';
import {
  syncKeys,
  useCancelSync,
  useStartSync,
  useSyncRun,
  useSyncRunEvents,
  useSyncRuns,
} from '../api/sync';
import { useTargets } from '../api/targets';
import SyncHistoryTable from './SyncHistoryTable';
import SyncPlanView from './SyncPlanView';
import SyncStatusTag from './SyncStatusTag';
import { formatBytes, formatDateTime, formatDurationMs } from '../utils/format';

export default function SyncPanel({ target }: { target: TargetDTO }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const runsQuery = useSyncRuns({ targetId: target.id, limit: 8 });
  const targetsQuery = useTargets({ projectId: target.projectId });
  const startMutation = useStartSync();
  const cancelMutation = useCancelSync();

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [livePlan, setLivePlan] = useState<SyncPlan | null>(null);
  const [liveProgress, setLiveProgress] = useState<SyncProgress | null>(null);
  const [liveStatus, setLiveStatus] = useState<SyncRunStatus | null>(null);
  const [relayOpen, setRelayOpen] = useState(false);
  const [relaySourceId, setRelaySourceId] = useState<string | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingSourceId, setPendingSourceId] = useState<string | undefined>(undefined);
  const [confirmText, setConfirmText] = useState('');

  const activeQuery = useSyncRun(activeRunId ?? undefined, Boolean(activeRunId));
  const inspectQuery = useSyncRun(inspectId ?? undefined);

  const mirrorDelete = Boolean(target.syncConfig.mirrorDelete);
  const confirmName = target.label || target.serverName || '该目标';
  const relaySources = (targetsQuery.data ?? []).filter(
    (item) => item.id !== target.id && item.syncMode === 'sftp',
  );

  useSyncRunEvents(activeRunId, (event: SyncRunEvent) => {
    if (event.type === 'status') {
      setLiveStatus(event.status);
    } else if (event.type === 'plan') {
      setLivePlan(event.plan);
    } else if (event.type === 'progress') {
      setLiveProgress(event);
    } else if (event.type === 'log' && event.level === 'error') {
      message.error(event.message);
    } else if (event.type === 'done') {
      if (event.status === 'done') {
        const changes = event.counts
          ? `：新增 ${event.counts.add}，更新 ${event.counts.updateSize + event.counts.updateMtime}${
              event.counts.delete > 0 ? `，删除 ${event.counts.delete}` : ''
            }`
          : '';
        message.success(`同步完成${changes}`);
      } else if (event.status === 'canceled') {
        message.warning('同步已取消');
      } else {
        message.error(event.error ?? '同步失败');
      }
      setActiveRunId(null);
      setLivePlan(null);
      setLiveProgress(null);
      setLiveStatus(null);
      void queryClient.invalidateQueries({ queryKey: syncKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['targets'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });

  const latest = runsQuery.data?.[0];
  const baseRun = inspectQuery.data ?? activeQuery.data ?? latest;
  const status = activeRunId ? (liveStatus ?? baseRun?.status) : baseRun?.status;
  const plan = livePlan ?? baseRun?.plan ?? null;

  const percent = liveProgress
    ? liveProgress.bytesTotal > 0
      ? Math.min(100, (liveProgress.bytesDone / liveProgress.bytesTotal) * 100)
      : liveProgress.filesTotal > 0
        ? (liveProgress.filesDone / liveProgress.filesTotal) * 100
        : 0
    : 0;

  const busy = Boolean(activeRunId) || startMutation.isPending;
  const unsupported = target.syncMode !== 'sftp';

  const start = async (options: {
    dryRun: boolean;
    sourceTargetId?: string;
    confirmTargetName?: string;
  }): Promise<void> => {
    setInspectId(null);
    setLivePlan(null);
    setLiveProgress(null);
    setLiveStatus(null);
    setRelayOpen(false);
    try {
      const run = await startMutation.mutateAsync({
        targetId: target.id,
        dryRun: options.dryRun,
        ...(options.sourceTargetId ? { sourceTargetId: options.sourceTargetId } : {}),
        ...(options.confirmTargetName ? { confirmTargetName: options.confirmTargetName } : {}),
      });
      setActiveRunId(run.id);
      setLiveStatus(run.status);
      setLivePlan(run.plan);
      const kind = options.sourceTargetId ? '服务器中转' : options.dryRun ? '差异检查' : '同步';
      message.info(`${kind}已开始`);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('同步启动失败');
    }
  };

  const requestStart = (dryRun: boolean, sourceTargetId?: string): void => {
    if (!dryRun && mirrorDelete) {
      setPendingSourceId(sourceTargetId);
      setConfirmText('');
      setConfirmOpen(true);
      return;
    }
    void start({ dryRun, sourceTargetId });
  };

  const cancel = async (): Promise<void> => {
    if (!activeRunId) return;
    try {
      await cancelMutation.mutateAsync(activeRunId);
      message.info('已请求取消，等待当前文件处理完成');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('取消失败');
    }
  };

  const openRelay = (): void => {
    setRelaySourceId(relaySources[0]?.id);
    setRelayOpen(true);
  };

  return (
    <>
      <Card
        size="small"
        title="代码同步（SFTP 增量）"
        extra={
          <Space wrap>
            <Button
              size="small"
              icon={<DiffOutlined />}
              loading={busy && startMutation.isPending}
              disabled={busy || unsupported}
              onClick={() => requestStart(true)}
            >
              检查差异
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={busy && startMutation.isPending}
              disabled={busy || unsupported}
              onClick={() => requestStart(false)}
            >
              开始同步
            </Button>
            {relaySources.length > 0 && (
              <Button
                size="small"
                icon={<SwapOutlined />}
                disabled={busy || unsupported}
                onClick={openRelay}
              >
                从其他服务器中转
              </Button>
            )}
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
          {unsupported && (
            <Alert type="info" showIcon message="该目标使用 Git 同步模式，SFTP 同步面板暂不可用。" />
          )}

          {mirrorDelete && (
            <Alert
              type="warning"
              showIcon
              message="镜像删除已开启"
              description={`真实同步会删除远端代码目录中多余的文件（.git、数据目录及忽略/保护规则命中的文件除外）；开始前需要输入目标名「${confirmName}」确认。`}
            />
          )}

          {activeRunId && (
            <div>
              <Space size={8} wrap>
                <SyncStatusTag status={status ?? 'pending'} />
                {baseRun?.dryRun && <Tag style={{ marginInlineEnd: 0 }}>差异检查</Tag>}
                {baseRun?.direction === 'target_to_target' && (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    服务器中转
                  </Tag>
                )}
                {liveProgress && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {liveProgress.filesDone}/{liveProgress.filesTotal} 文件 ·{' '}
                    {formatBytes(liveProgress.bytesDone)} / {formatBytes(liveProgress.bytesTotal)} ·{' '}
                    {formatBytes(liveProgress.rateBps)}/s
                    {liveProgress.etaMs != null ? ` · 剩余 ${formatDurationMs(liveProgress.etaMs)}` : ''}
                  </Typography.Text>
                )}
              </Space>
              <Progress percent={Math.round(percent)} status="active" style={{ marginTop: 6 }} />
            </div>
          )}

          {!activeRunId && baseRun?.error && <Alert type="error" showIcon message={baseRun.error} />}

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

          {plan ? (
            <SyncPlanView plan={plan} />
          ) : (
            <Typography.Text type="secondary">
              {runsQuery.isLoading
                ? '加载中…'
                : '尚未同步过：可先「检查差异」预览本次将传输的文件。'}
            </Typography.Text>
          )}

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

      <Modal
        title="从其他服务器中转同步"
        open={relayOpen}
        onCancel={() => setRelayOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setRelayOpen(false)}>取消</Button>
            <Button
              icon={<DiffOutlined />}
              disabled={!relaySourceId || busy}
              onClick={() => requestStart(true, relaySourceId)}
            >
              检查差异
            </Button>
            <Button
              type="primary"
              icon={<SwapOutlined />}
              disabled={!relaySourceId || busy}
              onClick={() => requestStart(false, relaySourceId)}
            >
              开始中转
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            以源服务器上的远程代码目录为准，下载到本机中转区后再上传到当前目标；不经过本地项目目录，也不要求两台服务器互信。
          </Typography.Paragraph>
          <Select
            style={{ width: '100%' }}
            placeholder="选择源服务器目标"
            value={relaySourceId}
            onChange={(value) => setRelaySourceId(value)}
            options={relaySources.map((item) => ({
              value: item.id,
              label: `${item.label || item.serverName || '目标'} · ${item.remoteCodeDir}`,
            }))}
          />
        </Space>
      </Modal>

      <Modal
        title="确认镜像删除"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        okText="确认并同步"
        cancelText="取消"
        okButtonProps={{
          danger: true,
          disabled: confirmText !== confirmName || startMutation.isPending,
        }}
        onOk={() => {
          setConfirmOpen(false);
          void start({
            dryRun: false,
            sourceTargetId: pendingSourceId,
            confirmTargetName: confirmText,
          });
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="本次同步会删除远端多余文件"
            description="受保护的路径（.git、数据目录、忽略规则与保护规则命中的文件）不会被删除。建议先执行一次「检查差异」查看删除清单。"
          />
          <div>
            <Typography.Text>
              请输入目标名 <Typography.Text code>{confirmName}</Typography.Text> 以确认：
            </Typography.Text>
            <Input
              style={{ marginTop: 8 }}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={confirmName}
              onPressEnter={() => {
                if (confirmText === confirmName && !startMutation.isPending) {
                  setConfirmOpen(false);
                  void start({
                    dryRun: false,
                    sourceTargetId: pendingSourceId,
                    confirmTargetName: confirmText,
                  });
                }
              }}
            />
          </div>
        </Space>
      </Modal>
    </>
  );
}