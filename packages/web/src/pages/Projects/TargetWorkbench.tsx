import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Result,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { ArrowLeftOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useProject } from '../../api/projects';
import { useServer } from '../../api/servers';
import { useTarget, useTargetPreview } from '../../api/targets';
import GitSyncPanel from '../../components/GitSyncPanel';
import RunPanel from '../../components/RunPanel';
import ScriptPreview from '../../components/ScriptPreview';
import ServerStatusTag from '../../components/ServerStatusTag';
import SyncPanel from '../../components/SyncPanel';
import { formatDateTime } from '../../utils/format';

export default function TargetWorkbenchPage() {
  const { id = '', targetId = '' } = useParams();
  const navigate = useNavigate();
  const targetQuery = useTarget(targetId);
  const projectQuery = useProject(id);
  const serverQuery = useServer(targetQuery.data?.serverId);
  const previewQuery = useTargetPreview(targetId);

  if (targetQuery.isLoading || projectQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }

  const target = targetQuery.data;
  const project = projectQuery.data;
  if (targetQuery.isError || !target || !project || project.id !== id || target.projectId !== id) {
    return (
      <Result
        status="404"
        title="目标不存在"
        subTitle="它可能已被删除"
        extra={
          <Button type="primary" onClick={() => navigate('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  const server = serverQuery.data;
  const envEntries = Object.entries(target.envVars);

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/projects/${project.id}`)} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 className="sm-page-title">{target.label || server?.name || target.serverName || '目标工作台'}</h1>
              <Tag color={target.syncMode === 'git' ? 'purple' : 'blue'} style={{ marginInlineEnd: 0 }}>
                {target.syncMode === 'git' ? 'Git 同步' : 'SFTP 同步'}
              </Tag>
              {target.condaEnv && (
                <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                  {target.condaEnv}
                </Tag>
              )}
              {server && <ServerStatusTag status={server.status} />}
            </div>
            <div className="sm-page-subtitle">
              {project.name} → {target.serverName ?? server?.name ?? '未知服务器'}
            </div>
          </div>
        </div>
        <Space wrap>
          <Button
            icon={<EditOutlined />}
            onClick={() => navigate(`/projects/${project.id}/targets/${target.id}/edit`)}
          >
            编辑目标
          </Button>
          <Button onClick={() => navigate(`/projects/${project.id}`)}>项目详情</Button>
        </Space>
      </div>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card size="small" title="配置摘要">
          <Descriptions column={{ xs: 1, md: 2 }} size="small">
            <Descriptions.Item label="远程代码目录" span={2}>
              <span className="mono">{target.remoteCodeDir}</span>
            </Descriptions.Item>
            <Descriptions.Item label="数据目录">
              <span className="mono">{target.dataDir ?? '—'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="GPU 设备">
              <span className="mono">{target.gpuDevices ?? '全部'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="conda 环境">{target.condaEnv ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="会话保留（tmux / screen）">
              {target.keepSession ? '任务结束保留' : '结束即关闭'}
            </Descriptions.Item>
            <Descriptions.Item label="最近同步">{formatDateTime(target.lastSyncAt)}</Descriptions.Item>
            <Descriptions.Item label="更新于">{formatDateTime(target.updatedAt)}</Descriptions.Item>
          </Descriptions>
        </Card>

        {target.syncMode === 'git' ? (
          <GitSyncPanel target={target} />
        ) : (
          <SyncPanel target={target} />
        )}

        <RunPanel target={target} caps={server?.caps} />

        <Card size="small" title="环境变量">
          {envEntries.length > 0 ? (
            <Descriptions column={1} size="small">
              {envEntries.map(([key, value]) => (
                <Descriptions.Item key={key} label={key}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {value}
                  </span>
                </Descriptions.Item>
              ))}
            </Descriptions>
          ) : (
            <Typography.Text type="secondary">未设置环境变量</Typography.Text>
          )}
        </Card>

        <Card size="small" title="命令模板">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {target.preCommand && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  前置命令
                </Typography.Text>
                <pre className="sm-code-block">{target.preCommand}</pre>
              </div>
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                运行命令
              </Typography.Text>
              <pre className="sm-code-block">{target.runCommand}</pre>
            </div>
          </Space>
        </Card>

        <Card
          size="small"
          title="脚本预览"
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={previewQuery.isFetching}
              onClick={() => void previewQuery.refetch()}
            >
              重新生成
            </Button>
          }
        >
          {previewQuery.isError && (
            <Alert type="error" showIcon message="脚本生成失败，请检查命令模板" />
          )}
          {previewQuery.data ? (
            <ScriptPreview preview={previewQuery.data} />
          ) : (
            !previewQuery.isError && <Spin />
          )}
        </Card>
      </Space>
    </div>
  );
}