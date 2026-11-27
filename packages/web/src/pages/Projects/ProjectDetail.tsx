import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Result,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  EyeOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type {
  IgnoreExplainResult,
  ProjectDTO,
  ProjectScanResult,
  SyncRunDTO,
  TargetDTO,
  TargetPreview,
} from '@sm/shared';
import { DEFAULT_IGNORE_PATTERNS, HARD_IGNORE_PATTERNS } from '@sm/shared';
import { ApiError } from '../../api/client';
import { useDeleteProject, useExplainIgnore, useProject, useScanProject } from '../../api/projects';
import { useDeleteTarget, usePreviewSavedTarget, useTargets } from '../../api/targets';
import { useServers } from '../../api/servers';
import { useSyncRuns } from '../../api/sync';
import ScriptPreview from '../../components/ScriptPreview';
import ServerStatusTag from '../../components/ServerStatusTag';
import SyncPlanView from '../../components/SyncPlanView';
import SyncStatusTag from '../../components/SyncStatusTag';
import { formatBytes, formatDateTime, formatDurationMs } from '../../utils/format';

const SOURCE_LABEL: Record<string, string> = {
  default: '默认规则',
  project: '项目规则',
  target: '目标规则',
  hard: '硬黑名单',
};

export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const projectQuery = useProject(id);
  const targetsQuery = useTargets({ projectId: id });
  const serversQuery = useServers();
  const syncRunsQuery = useSyncRuns({ projectId: id, limit: 50 });
  const scanMutation = useScanProject(id);
  const explainMutation = useExplainIgnore(id);
  const previewMutation = usePreviewSavedTarget();
  const deleteTargetMutation = useDeleteTarget();
  const deleteProjectMutation = useDeleteProject();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const [previewView, setPreviewView] = useState<{ name: string; preview: TargetPreview } | null>(null);
  const [scan, setScan] = useState<ProjectScanResult | null>(null);
  const [explainPath, setExplainPath] = useState('');
  const [explainTargetId, setExplainTargetId] = useState<string | undefined>(undefined);
  const [explainResult, setExplainResult] = useState<IgnoreExplainResult | null>(null);
  const [syncRunView, setSyncRunView] = useState<SyncRunDTO | null>(null);

  if (projectQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    return (
      <Result
        status="404"
        title="项目不存在"
        subTitle="它可能已被删除"
        extra={
          <Button type="primary" onClick={() => navigate('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  const project = projectQuery.data;
  const targets = targetsQuery.data ?? [];
  const servers = serversQuery.data ?? [];
  const serverById = new Map(servers.map((server) => [server.id, server]));

  const handleScan = async () => {
    try {
      const result = await scanMutation.mutateAsync();
      setScan(result);
      message.success(`扫描完成：${result.files} 个文件，忽略 ${result.ignoredEntries} 项`);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('扫描失败');
    }
  };

  const handlePreview = async (target: TargetDTO) => {
    try {
      const preview = await previewMutation.mutateAsync(target.id);
      setPreviewView({ name: target.label || target.serverName || '目标', preview });
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('脚本预览失败');
    }
  };

  const handleDeleteTarget = (target: TargetDTO) => {
    modal.confirm({
      title: `删除目标「${target.label || target.serverName}」？`,
      content: '该目标下的任务记录将一并删除，此操作不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteTargetMutation.mutateAsync(target.id);
          message.success('目标已删除');
        } catch (err) {
          if (err instanceof ApiError) message.error(err.message);
          else message.error('删除失败');
        }
      },
    });
  };

  const handleDeleteProject = () => {
    modal.confirm({
      title: `删除项目「${project.name}」？`,
      content:
        (project.targetCount ?? 0) > 0
          ? `该项目下有 ${project.targetCount} 个目标，相关任务记录会一并删除，此操作不可恢复。`
          : '删除后需要重新添加项目目录。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteProjectMutation.mutateAsync(project.id);
          message.success('项目已删除');
          navigate('/projects');
        } catch (err) {
          if (err instanceof ApiError) message.error(err.message);
          else message.error('删除失败');
        }
      },
    });
  };

  const handleExplain = async () => {
    if (!explainPath.trim()) {
      message.warning('请先填写相对路径');
      return;
    }
    try {
      const result = await explainMutation.mutateAsync({
        path: explainPath.trim(),
        ...(explainTargetId ? { targetId: explainTargetId } : {}),
      });
      setExplainResult(result);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('检查失败');
    }
  };

  const targetColumns: TableColumnsType<TargetDTO> = [
    {
      title: '目标',
      key: 'target',
      width: 160,
      render: (_, target) => (
        <div>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0, fontWeight: 500 }}
            onClick={() => navigate(`/projects/${project.id}/targets/${target.id}`)}
          >
            {target.label || target.serverName || '未命名目标'}
          </Button>
          <div className="text-muted" style={{ fontSize: 12 }}>
            {target.projectName}
          </div>
        </div>
      ),
    },
    {
      title: '服务器',
      key: 'server',
      width: 150,
      render: (_, target) => {
        const server = serverById.get(target.serverId);
        return (
          <Space size={6}>
            <span>{target.serverName ?? '—'}</span>
            {server && <ServerStatusTag status={server.status} />}
          </Space>
        );
      },
    },
    {
      title: '远程代码目录',
      dataIndex: 'remoteCodeDir',
      render: (value: string) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {value}
        </span>
      ),
    },
    {
      title: '数据目录',
      dataIndex: 'dataDir',
      width: 150,
      render: (value: string | null) => (
        <span className="mono text-muted" style={{ fontSize: 12 }}>
          {value ?? '—'}
        </span>
      ),
    },
    {
      title: '环境',
      key: 'env',
      width: 130,
      render: (_, target) =>
        target.condaEnv ? (
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
            {target.condaEnv}
          </Tag>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      title: '同步',
      dataIndex: 'syncMode',
      width: 80,
      render: (value: string) => (
        <Tag color={value === 'git' ? 'purple' : 'blue'} style={{ marginInlineEnd: 0 }}>
          {value === 'git' ? 'Git' : 'SFTP'}
        </Tag>
      ),
    },
    {
      title: '最近同步',
      key: 'lastSyncAt',
      width: 150,
      render: (_, target) => (
        <span className="text-muted" style={{ fontSize: 12 }}>
          {formatDateTime(target.lastSyncAt)}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_, target) => (
        <Space size={0} wrap>
          <Button
            type="link"
            size="small"
            icon={<ExportOutlined />}
            onClick={() => navigate(`/projects/${project.id}/targets/${target.id}`)}
          >
            工作台
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            loading={previewMutation.isPending && previewMutation.variables === target.id}
            onClick={() => void handlePreview(target)}
          >
            预览
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/projects/${project.id}/targets/${target.id}/edit`)}
          >
            编辑
          </Button>
          <Button type="link" size="small" danger onClick={() => handleDeleteTarget(target)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const scanColumns: TableColumnsType<ProjectScanResult['topLevel'][number]> = [
    { title: '名称', dataIndex: 'name', ellipsis: true },
    {
      title: '类型',
      dataIndex: 'type',
      width: 70,
      render: (value: 'file' | 'dir') => (value === 'dir' ? '目录' : '文件'),
    },
    {
      title: '状态',
      dataIndex: 'ignored',
      width: 90,
      render: (ignored: boolean) =>
        ignored ? (
          <Tag color="warning" style={{ marginInlineEnd: 0 }}>
            忽略
          </Tag>
        ) : (
          <Tag color="success" style={{ marginInlineEnd: 0 }}>
            同步
          </Tag>
        ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      width: 100,
      render: (value: number | null) => (value == null ? '—' : formatBytes(value)),
    },
  ];

  const explainAlert = explainResult ? (
    explainResult.ignored ? (
      <Alert
        type="warning"
        showIcon
        message={`会被忽略：${explainResult.rule ?? '匹配忽略规则'}`}
        description={`来源：${SOURCE_LABEL[explainResult.source ?? ''] ?? '未知'}`}
      />
    ) : (
      <Alert
        type="success"
        showIcon
        message="不会被忽略，会被同步"
        description="没有任何默认 / 项目 / 目标级规则命中此路径。"
      />
    )
  ) : null;

  const ignoreTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="默认忽略规则"
        extra={<Typography.Text type="secondary">硬黑名单不可取消</Typography.Text>}
      >
        <Space size={[6, 6]} wrap>
          {DEFAULT_IGNORE_PATTERNS.map((pattern) => (
            <Tag key={pattern} style={{ marginInlineEnd: 0 }}>
              {pattern}
            </Tag>
          ))}
          {HARD_IGNORE_PATTERNS.map((pattern) => (
            <Tag key={pattern} color="red" style={{ marginInlineEnd: 0 }}>
              {pattern}（硬）
            </Tag>
          ))}
        </Space>
      </Card>

      <Card
        size="small"
        title={`项目级规则（${project.ignoreExtra.length} 条）`}
        extra={
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/projects/${project.id}/edit`)}
          >
            编辑规则
          </Button>
        }
      >
        {project.ignoreExtra.length > 0 ? (
          <pre className="sm-code-block">{project.ignoreExtra.join('\n')}</pre>
        ) : (
          <Typography.Text type="secondary">未配置项目级规则，仅使用默认规则。</Typography.Text>
        )}
      </Card>

      <Card
        size="small"
        title="扫描本地目录"
        extra={
          <Button
            size="small"
            type="primary"
            icon={<FolderOpenOutlined />}
            loading={scanMutation.isPending}
            onClick={() => void handleScan()}
          >
            开始扫描
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: scan ? 12 : 0 }}>
          按当前忽略规则统计将要同步的文件，不会访问服务器。
        </Typography.Paragraph>
        {scan && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {scan.truncated && (
              <Alert
                type="warning"
                showIcon
                message="文件数量超过扫描上限（50000），统计结果已截断。请检查本地目录是否选错。"
              />
            )}
            <Descriptions size="small" column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="文件">{scan.files}</Descriptions.Item>
              <Descriptions.Item label="目录">{scan.dirs}</Descriptions.Item>
              <Descriptions.Item label="总大小">{formatBytes(scan.bytes)}</Descriptions.Item>
              <Descriptions.Item label="忽略条目">{scan.ignoredEntries}</Descriptions.Item>
              <Descriptions.Item label="跳过符号链接">{scan.skippedSymlinks}</Descriptions.Item>
              <Descriptions.Item label="耗时">{scan.durationMs} ms</Descriptions.Item>
            </Descriptions>
            <Table
              size="small"
              rowKey="name"
              pagination={false}
              dataSource={scan.topLevel}
              columns={scanColumns}
              scroll={{ y: 260 }}
              locale={{ emptyText: '目录为空' }}
            />
          </Space>
        )}
      </Card>

      <Card size="small" title="为什么这个文件被忽略">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Input
              className="mono"
              style={{ width: 320 }}
              placeholder="相对路径，如 src/data/sample.csv 或 logs/"
              value={explainPath}
              onChange={(event) => setExplainPath(event.target.value)}
              onPressEnter={() => void handleExplain()}
            />
            <Select
              allowClear
              style={{ width: 220 }}
              placeholder="按目标检查（可选）"
              value={explainTargetId}
              onChange={(value) => setExplainTargetId(value)}
              options={targets.map((target) => ({
                value: target.id,
                label: `${target.label || target.serverName}（目标级规则）`,
              }))}
            />
            <Button
              icon={<SearchOutlined />}
              loading={explainMutation.isPending}
              onClick={() => void handleExplain()}
            >
              检查
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            目录请以 / 结尾；未选择目标时只应用默认与项目级规则。
          </Typography.Text>
          {explainAlert}
        </Space>
      </Card>
    </Space>
  );

  const targetsTab =
    targets.length > 0 ? (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {servers.length === 0 && (
          <Alert
            type="info"
            showIcon
            message="还没有服务器，添加后才能创建目标"
            action={
              <Button size="small" onClick={() => navigate('/servers/new')}>
                添加服务器
              </Button>
            }
          />
        )}
        <Table
          rowKey="id"
          loading={targetsQuery.isLoading}
          columns={targetColumns}
          dataSource={targets}
          pagination={false}
          scroll={{ x: 1180 }}
        />
      </Space>
    ) : (
      <Empty description="该项目还没有绑定任何服务器目标">
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate(`/projects/${project.id}/targets/new`)}
          disabled={servers.length === 0}
        >
          添加目标
        </Button>
      </Empty>
    );

  const syncTargetLabel = (targetId: string | null): string => {
    if (!targetId) return '—';
    const target = targets.find((item) => item.id === targetId);
    return target ? target.label || target.serverName || '目标' : '已删除的目标';
  };

  const syncColumns: TableColumnsType<SyncRunDTO> = [
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      width: 140,
      render: (value: string) => <span style={{ fontSize: 12 }}>{formatDateTime(value)}</span>,
    },
    {
      title: '目标',
      key: 'target',
      width: 170,
      render: (_, run) => (
        <div>
          <div>{run.plan?.dest.label ?? syncTargetLabel(run.targetId)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {run.direction === 'target_to_target' ? '服务器中转' : '本地 → 远程'}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '方式',
      key: 'mode',
      width: 84,
      render: (_, run) => (
        <Tag
          color={run.dryRun ? 'gold' : run.mode === 'git' ? 'purple' : 'blue'}
          style={{ marginInlineEnd: 0 }}
        >
          {run.dryRun ? '预览' : run.mode === 'git' ? 'Git' : 'SFTP'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 88,
      render: (status: SyncRunDTO['status']) => <SyncStatusTag status={status} />,
    },
    {
      title: '变更',
      key: 'changes',
      width: 150,
      render: (_, run) => {
        if (!run.counts) return <span className="text-muted">—</span>;
        const updates = run.counts.updateSize + run.counts.updateMtime;
        return (
          <Space size={4} wrap>
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              +{run.counts.add}
            </Tag>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              ~{updates}
            </Tag>
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              -{run.counts.delete}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: '数据量',
      key: 'bytes',
      width: 150,
      render: (_, run) =>
        run.bytes ? (
          <span style={{ fontSize: 12 }}>
            ↑ {formatBytes(run.bytes.upload)}
            {run.bytes.delete > 0 && (
              <span className="text-muted"> / 删 {formatBytes(run.bytes.delete)}</span>
            )}
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      title: '耗时',
      key: 'duration',
      width: 90,
      render: (_, run) => (
        <span style={{ fontSize: 12 }}>
          {formatDurationMs(
            run.finishedAt
              ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
              : null,
          )}
        </span>
      ),
    },
    {
      title: '结果',
      key: 'error',
      render: (_, run) => (
        <span className="text-muted" style={{ fontSize: 12 }}>
          {run.error ?? (run.counts ? '成功' : '—')}
        </span>
      ),
    },
  ];

  const syncHistoryTab = (
    <Card
      size="small"
      title="同步历史"
      extra={
        <Button
          size="small"
          onClick={() => void syncRunsQuery.refetch()}
          loading={syncRunsQuery.isFetching}
        >
          刷新
        </Button>
      }
    >
      <Table
        rowKey="id"
        size="small"
        loading={syncRunsQuery.isLoading}
        columns={syncColumns}
        dataSource={syncRunsQuery.data ?? []}
        pagination={false}
        scroll={{ x: 1040 }}
        locale={{ emptyText: '暂无同步记录，在目标工作台执行一次同步吧' }}
        onRow={(run) => ({ onClick: () => setSyncRunView(run), style: { cursor: 'pointer' } })}
      />
    </Card>
  );

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 className="sm-page-title">{project.name}</h1>
              <Tag style={{ marginInlineEnd: 0 }}>目标 {project.targetCount ?? 0}</Tag>
            </div>
            <div className="sm-page-subtitle mono">{project.localRoot}</div>
          </div>
        </div>
        <Space wrap>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate(`/projects/${project.id}/targets/new`)}
            disabled={servers.length === 0}
          >
            添加目标
          </Button>
          <Button icon={<EditOutlined />} onClick={() => navigate(`/projects/${project.id}/edit`)}>
            编辑
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={handleDeleteProject}>
            删除
          </Button>
        </Space>
      </div>

      <Card styles={{ body: { paddingTop: 8 } }}>
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label="执行位策略">
            {project.execBitPolicy === 'all755' ? '全部 755' : '跟随本地'}
          </Descriptions.Item>
          <Descriptions.Item label="项目级忽略规则">{project.ignoreExtra.length} 条</Descriptions.Item>
          <Descriptions.Item label="创建 / 更新">
            {formatDateTime(project.createdAt)} / {formatDateTime(project.updatedAt)}
          </Descriptions.Item>
        </Descriptions>
        <Tabs
          style={{ marginTop: 4 }}
          items={[
            { key: 'targets', label: '目标（Target）', children: targetsTab },
            { key: 'ignore', label: '忽略规则', children: ignoreTab },
            { key: 'sync', label: '同步历史', children: syncHistoryTab },
          ]}
        />
      </Card>

      <Drawer
        title={previewView ? `脚本预览 · ${previewView.name}` : '脚本预览'}
        width={680}
        open={previewView !== null}
        onClose={() => setPreviewView(null)}
      >
        {previewView && <ScriptPreview preview={previewView.preview} />}
      </Drawer>

      <Drawer
        title={syncRunView ? `同步详情 · ${formatDateTime(syncRunView.startedAt)}` : '同步详情'}
        width={760}
        open={syncRunView !== null}
        onClose={() => setSyncRunView(null)}
      >
        {syncRunView && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap size={[8, 8]}>
              <SyncStatusTag status={syncRunView.status} />
              <Tag color={syncRunView.dryRun ? 'gold' : 'blue'}>
                {syncRunView.dryRun ? '预览（未写入）' : '真实同步'}
              </Tag>
              <Tag color={syncRunView.direction === 'target_to_target' ? 'purple' : 'blue'}>
                {syncRunView.direction === 'target_to_target' ? '服务器中转' : '本地 → 远程'}
              </Tag>
              <Tag>{syncRunView.mode === 'git' ? 'Git' : 'SFTP'}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                耗时{' '}
                {formatDurationMs(
                  syncRunView.finishedAt
                    ? new Date(syncRunView.finishedAt).getTime() -
                        new Date(syncRunView.startedAt).getTime()
                    : null,
                )}
              </Typography.Text>
            </Space>
            {syncRunView.error && <Alert type="error" showIcon message={syncRunView.error} />}
            {syncRunView.plan ? (
              <>
                <Typography.Text style={{ fontSize: 12 }}>
                  <span className="mono">{syncRunView.plan.source.label}</span>
                  {' → '}
                  <span className="mono">{syncRunView.plan.dest.label}</span>
                </Typography.Text>
                <SyncPlanView plan={syncRunView.plan} />
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该记录没有保存差异计划" />
            )}
            {syncRunView.outputTail && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  输出
                </Typography.Text>
                <pre className="sm-code-block" style={{ maxHeight: 220, overflow: 'auto' }}>
                  {syncRunView.outputTail}
                </pre>
              </div>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
}