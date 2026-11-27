import { Alert, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { useHealth } from '../../api/health';

export default function SettingsPage() {
  const { data, isError, error } = useHealth();

  return (
    <div>
      <div className="sm-page-header">
        <div>
          <h1 className="sm-page-title">设置</h1>
          <div className="sm-page-subtitle">运行信息与全局参数</div>
        </div>
      </div>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card title="运行信息">
          {isError ? (
            <Typography.Text type="danger">无法连接本地服务：{error instanceof Error ? error.message : '未知错误'}</Typography.Text>
          ) : (
            <Descriptions column={2} size="small">
              <Descriptions.Item label="版本">{data?.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Node">{data?.node ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="运行时长">{data ? `${data.uptime}s` : '—'}</Descriptions.Item>
              <Descriptions.Item label="模式">
                <Tag color={data?.demo ? 'gold' : 'blue'}>{data?.demo ? '演示模式' : '本地'}</Tag>
              </Descriptions.Item>
            </Descriptions>
          )}
        </Card>
        <Card title="演示模式">
          {data?.demo ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Alert
                type="warning"
                showIcon
                message="当前为演示模式（SM_DEMO=1）"
                description="服务器、GPU 波动、任务与日志、同步记录全部为本地合成数据，不会发起任何 SSH 连接。演示数据只在首次启动时写入，重启不会重复叠加。"
              />
              <Typography.Text type="secondary">
                退出演示：结束程序后去掉 SM_DEMO 重新启动。如需清空演示数据，删除数据目录中的 SQLite 数据库后重启，或改用独立的 SM_DATA_DIR。
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              设置环境变量 <Typography.Text code>SM_DEMO=1</Typography.Text> 后重新启动，可载入 3 台合成
              GPU 服务器、项目、任务与同步记录，用于无真实机器时的完整走查。建议同时用{' '}
              <Typography.Text code>SM_DATA_DIR</Typography.Text> 指向临时目录，避免与真实数据混用。
            </Typography.Text>
          )}
        </Card>
      </Space>
    </div>
  );
}