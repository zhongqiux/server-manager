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
  Result,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  ApiOutlined,
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ServerTestResult, TargetDTO } from '@sm/shared';
import { useDeleteServer, useProbeServer, useServer, useTestServer } from '../../api/servers';
import { useJobs } from '../../api/jobs';
import { useTargets } from '../../api/targets';
import { ApiError } from '../../api/client';
import CapsTags from '../../components/CapsTags';
import GpuDetailTable from '../../components/GpuDetailTable';
import HardwareView from '../../components/HardwareView';
import ServerStatusTag from '../../components/ServerStatusTag';
import ServerTestResultView from '../../components/ServerTestResultView';
import { formatDateTime } from '../../utils/format';

export default function ServerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const serverQuery = useServer(id);
  const jobsQuery = useJobs({ serverId: id, active: true }, 5000);
  const testMutation = useTestServer(id);
  const probeMutation = useProbeServer(id);
  const deleteMutation = useDeleteServer();
  const [testResult, setTestResult] = useState<ServerTestResult | null>(null);

  if (serverQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }

  if (serverQuery.isError || !serverQuery.data) {
    return (
      <Result
        status="404"
        title="服务器不存在"
        subTitle="它可能已被删除"
        extra={
          <Button type="primary" onClick={() => navigate('/servers')}>
            返回服务器列表
          </Button>
        }
      />
    );
  }

  const server = serverQuery.data;

  const handleTest = async () => {
    try {
      const result = await testMutation.mutateAsync(undefined);
      setTestResult(result);
      if (result.ok) message.success(`连接成功（${result.latencyMs} ms）`);
      else message.warning(result.error?.message ?? '连接测试未通过');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('连接测试失败');
    }
  };

  const handleProbe = async () => {
    try {
      await probeMutation.mutateAsync();
      message.success('硬件信息已刷新');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('硬件采集失败');
    }
  };

  const handleDelete = (force = false) => {
    modal.confirm({
      title: force ? `级联删除「${server.name}」？` : `删除服务器「${server.name}」？`,
      content: force
        ? '该服务器下的所有目标与任务记录将一并删除，此操作不可恢复。'
        : server.targetCount
          ? `该服务器被 ${server.targetCount} 个目标引用，删除前需要确认级联影响。`
          : '删除后需要重新添加连接信息。',
      okText: force ? '级联删除' : '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteMutation.mutateAsync({ id: server.id, force });
          message.success('服务器已删除');
          navigate('/servers');
        } catch (err) {
          if (err instanceof ApiError && err.code === 'TARGETS_EXIST') {
            handleDelete(true);
            return;
          }
          if (err instanceof ApiError) message.error(err.message);
          else message.error('删除失败');
        }
      },
    });
  };

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/servers')} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 className="sm-page-title">{server.name}</h1>
              <ServerStatusTag status={server.status} />
              {server.gpu?.supported && (
                <Tag color={server.gpu.idleCount > 0 ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
                  空闲 {server.gpu.idleCount}/{server.gpu.gpus.length}
                </Tag>
              )}
              {server.tags.map((tag) => (
                <Tag key={tag} style={{ marginInlineEnd: 0 }}>
                  {tag}
                </Tag>
              ))}
            </div>
            <div className="sm-page-subtitle mono">
              {server.username}@{server.host}:{server.port}
            </div>
          </div>
        </div>
        <Space wrap>
          <Button icon={<ApiOutlined />} loading={testMutation.isPending} onClick={handleTest}>
            测试连接
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={probeMutation.isPending}
            onClick={handleProbe}
            disabled={server.status !== 'online'}
          >
            刷新硬件
          </Button>
          <Button icon={<EditOutlined />} onClick={() => navigate(`/servers/${server.id}/edit`)}>
            编辑
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={() => handleDelete()}>
            删除
          </Button>
        </Space>
      </div>

      {server.statusMsg && (
        <Alert
          style={{ marginBottom: 16 }}
          type={server.status === 'online' ? 'success' : server.status === 'auth_failed' ? 'warning' : 'error'}
          showIcon
          message={server.statusMsg}
        />
      )}

      <Card styles={{ body: { paddingTop: 8 } }}>
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="认证方式">
            {server.authType === 'password' ? '密码' : '私钥'}
            {server.authType === 'key' && server.hasPassphrase ? '（带口令）' : ''}
          </Descriptions.Item>
          <Descriptions.Item label="主机指纹策略">
            {server.hostKeyPolicy === 'strict' ? '严格校验' : '首次信任（TOFU）'}
          </Descriptions.Item>
          <Descriptions.Item label="主机指纹" span={2}>
            <span className="mono" style={{ fontSize: 12 }}>
              {server.hostKeyFp ?? '尚未记录'}
            </span>
          </Descriptions.Item>
          <Descriptions.Item label="最近成功连接">{formatDateTime(server.lastOkAt)}</Descriptions.Item>
          <Descriptions.Item label="硬件采集">{formatDateTime(server.hardwareAt)}</Descriptions.Item>
          <Descriptions.Item label="关联目标">{server.targetCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="运行中任务">{server.runningJobs ?? 0}</Descriptions.Item>
          {server.notes && (
            <Descriptions.Item label="备注" span={2}>
              {server.notes}
            </Descriptions.Item>
          )}
        </Descriptions>

        <Tabs
          style={{ marginTop: 4 }}
          items={[
            {
              key: 'hardware',
              label: '硬件信息',
              children: (
                <HardwareView
                  hardware={server.hardware}
                  onProbe={handleProbe}
                  probing={probeMutation.isPending}
                />
              ),
            },
            {
              key: 'gpu',
              label: 'GPU 实时',
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type="info"
                    showIcon
                    message="打开任意页面时会保持 GPU 轮询（约 5 秒一次）；所有页面关闭 30 秒后自动暂停，避免后台空转。"
                  />
                  <GpuDetailTable servers={[server]} runningJobs={jobsQuery.data ?? []} showServer={false} />
                </Space>
              ),
            },
            {
              key: 'targets',
              label: '关联目标',
              children: <ServerTargets serverId={server.id} />,
            },
            {
              key: 'connection',
              label: '连接与能力',
              children: (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      远程能力（最近一次连接测试结果）
                    </Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <CapsTags caps={server.caps} />
                    </div>
                  </div>
                  <Descriptions bordered size="small" column={1}>
                    <Descriptions.Item label="SSH 地址">
                      <span className="mono">
                        {server.username}@{server.host}:{server.port}
                      </span>
                    </Descriptions.Item>
                    <Descriptions.Item label="凭据状态">
                      {server.authType === 'password' ? '密码' : '私钥'}
                      {server.hasPassword || server.hasPrivateKey ? '已保存（加密）' : '未保存'}
                    </Descriptions.Item>
                    <Descriptions.Item label="创建 / 更新">
                      {formatDateTime(server.createdAt)} / {formatDateTime(server.updatedAt)}
                    </Descriptions.Item>
                  </Descriptions>
                  <Alert
                    type="info"
                    showIcon
                    message="能力探测结果决定同步与任务模式的可用性：任务自动模式按 tmux → screen → nohup 降级，无 GNU find 会回退到 SFTP 清单。"
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title="连接测试结果"
        width={480}
        open={testResult !== null}
        onClose={() => setTestResult(null)}
      >
        {testResult && <ServerTestResultView result={testResult} />}
      </Drawer>
    </div>
  );
}

function ServerTargets({ serverId }: { serverId: string }) {
  const navigate = useNavigate();
  const targetsQuery = useTargets({ serverId });
  const targets = targetsQuery.data ?? [];

  const columns: TableColumnsType<TargetDTO> = [
    {
      title: '项目',
      key: 'project',
      width: 180,
      render: (_, target) => (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          onClick={() => navigate(`/projects/${target.projectId}`)}
        >
          {target.projectName}
        </Button>
      ),
    },
    {
      title: '目标别名',
      dataIndex: 'label',
      width: 140,
      render: (value: string | null) => value ?? <span className="text-muted">—</span>,
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
      title: 'conda',
      dataIndex: 'condaEnv',
      width: 120,
      render: (value: string | null) => value ?? <span className="text-muted">—</span>,
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
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_, target) => (
        <Button
          type="link"
          size="small"
          onClick={() => navigate(`/projects/${target.projectId}/targets/${target.id}`)}
        >
          工作台
        </Button>
      ),
    },
  ];

  if (targetsQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
        <Spin />
      </div>
    );
  }

  if (targets.length === 0) {
    return (
      <Empty description="该服务器还没有绑定任何项目目标">
        <Button type="primary" onClick={() => navigate('/projects')}>
          去项目页创建目标
        </Button>
      </Empty>
    );
  }

  return (
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={targets}
      columns={columns}
      scroll={{ x: 900 }}
    />
  );
}