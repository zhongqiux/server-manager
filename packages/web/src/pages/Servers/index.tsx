import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Drawer,
  Empty,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  ApiOutlined,
  EditOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import type { ServerDTO, ServerTestResult } from '@sm/shared';
import { useDeleteServer, useServers, useTestServerById } from '../../api/servers';
import { ApiError } from '../../api/client';
import ServerStatusTag from '../../components/ServerStatusTag';
import ServerTestResultView from '../../components/ServerTestResultView';
import { formatDateTime, formatGb } from '../../utils/format';

export default function ServersPage() {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const serversQuery = useServers();
  const testMutation = useTestServerById();
  const deleteMutation = useDeleteServer();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testView, setTestView] = useState<{ name: string; result: ServerTestResult } | null>(null);

  const runTest = async (server: ServerDTO) => {
    setTestingId(server.id);
    try {
      const result = await testMutation.mutateAsync(server.id);
      setTestView({ name: server.name, result });
      if (result.ok) message.success(`${server.name}：连接成功（${result.latencyMs} ms）`);
      else message.warning(`${server.name}：${result.error?.message ?? '连接测试未通过'}`);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('连接测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const confirmDelete = (server: ServerDTO, force = false) => {
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
        } catch (err) {
          if (err instanceof ApiError && err.code === 'TARGETS_EXIST') {
            confirmDelete(server, true);
            return;
          }
          if (err instanceof ApiError) message.error(err.message);
          else message.error('删除失败');
        }
      },
    });
  };

  const columns: TableColumnsType<ServerDTO> = [
    {
      title: '服务器',
      key: 'name',
      width: 180,
      render: (_, server) => (
        <div>
          <Space size={6}>
            <Link to={`/servers/${server.id}`} style={{ fontWeight: 500 }}>
              {server.name}
            </Link>
            {server.hostKeyFp && (
              <Tooltip title={`主机指纹已记录：${server.hostKeyFp}`}>
                <SafetyCertificateOutlined style={{ color: '#16a34a' }} />
              </Tooltip>
            )}
          </Space>
          <div className="text-muted" style={{ fontSize: 12 }}>
            {server.tags.length > 0 ? server.tags.join(' · ') : '—'}
          </div>
        </div>
      ),
    },
    {
      title: '地址',
      key: 'address',
      render: (_, server) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {server.username}@{server.host}:{server.port}
        </span>
      ),
    },
    {
      title: '认证',
      key: 'auth',
      width: 90,
      render: (_, server) => (
        <Tag style={{ marginInlineEnd: 0 }}>
          {server.authType === 'password' ? '密码' : '私钥'}
          {server.hasPassphrase ? ' + 口令' : ''}
        </Tag>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 150,
      render: (_, server) => (
        <Space direction="vertical" size={0}>
          <ServerStatusTag status={server.status} />
          {server.statusMsg && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: server.statusMsg }}>
              {server.statusMsg}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'GPU',
      key: 'gpu',
      width: 110,
      render: (_, server) => {
        const gpu = server.gpu;
        if (gpu?.supported) {
          return (
            <Space direction="vertical" size={0}>
              <Tag color={gpu.idleCount > 0 ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
                空闲 {gpu.idleCount}/{gpu.gpus.length}
              </Tag>
              {gpu.stale && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  离线快照
                </Typography.Text>
              )}
            </Space>
          );
        }
        const count = server.hardware?.gpuList?.length ?? 0;
        if (!server.hardware) return <span className="text-muted">—</span>;
        return count > 0 ? <span className="text-muted">{count} 卡</span> : <span className="text-muted">无</span>;
      },
    },
    {
      title: '内存',
      key: 'mem',
      width: 100,
      render: (_, server) => (
        <span className="text-muted">{formatGb(server.hardware?.memTotalMb, 0)}</span>
      ),
    },
    {
      title: '目标',
      dataIndex: 'targetCount',
      width: 70,
      render: (value: number | undefined) => value ?? 0,
    },
    {
      title: '运行中',
      dataIndex: 'runningJobs',
      width: 80,
      render: (value: number | undefined) =>
        value ? <Tag color="processing">{value}</Tag> : <span className="text-muted">0</span>,
    },
    {
      title: '最近成功',
      key: 'lastOkAt',
      width: 140,
      render: (_, server) => (
        <span className="text-muted" style={{ fontSize: 12 }}>
          {formatDateTime(server.lastOkAt)}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_, server) => (
        <Space size={0} wrap>
          <Button type="link" size="small" onClick={() => navigate(`/servers/${server.id}`)}>
            详情
          </Button>
          <Button
            type="link"
            size="small"
            icon={<ApiOutlined />}
            loading={testingId === server.id}
            onClick={() => void runTest(server)}
          >
            测试
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/servers/${server.id}/edit`)}
          >
            编辑
          </Button>
          <Button type="link" size="small" danger onClick={() => confirmDelete(server)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="sm-page-header">
        <div>
          <h1 className="sm-page-title">服务器</h1>
          <div className="sm-page-subtitle">管理 SSH 连接、硬件快照与远程能力</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/servers/new')}>
          添加服务器
        </Button>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={serversQuery.isLoading}
          columns={columns}
          dataSource={serversQuery.data ?? []}
          pagination={false}
          scroll={{ x: 1120 }}
          locale={{
            emptyText: (
              <Empty description="还没有服务器，先添加一台机器吧">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/servers/new')}>
                  添加服务器
                </Button>
              </Empty>
            ),
          }}
        />
      </Card>

      <Drawer
        title={testView ? `连接测试 · ${testView.name}` : '连接测试结果'}
        width={480}
        open={testView !== null}
        onClose={() => setTestView(null)}
      >
        {testView && <ServerTestResultView result={testView.result} />}
      </Drawer>
    </div>
  );
}