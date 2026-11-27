import { Alert, Badge, Layout, Menu, Tag } from 'antd';
import {
  CloudServerOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useHealth } from '../api/health';
import { useGlobalEvents } from '../hooks/useGlobalEvents';

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '总览' },
  { key: '/servers', icon: <CloudServerOutlined />, label: '服务器' },
  { key: '/projects', icon: <ExperimentOutlined />, label: '项目' },
  { key: '/jobs', icon: <PlayCircleOutlined />, label: '任务' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
];

function selectedKey(pathname: string): string {
  if (pathname === '/') return '/';
  const match = menuItems.find((item) => item.key !== '/' && pathname.startsWith(item.key));
  return match?.key ?? '/';
}

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  useGlobalEvents();
  const demo = useHealth().data?.demo === true;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={208} style={{ position: 'sticky', top: 0, height: '100vh' }}>
        <div className="sm-logo">
          <ThunderboltFilled className="sm-logo-icon" />
          <span>科研 GPU 调度台</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey(location.pathname)]}
          items={menuItems}
          onClick={(info) => navigate(info.key)}
          style={{ background: 'transparent', borderInlineEnd: 0 }}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          <span style={{ fontWeight: 500, color: '#0f172a' }}>多服务器科研实验调度</span>
          <span className="sm-header-status">
            {demo ? (
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                演示模式 · 合成数据
              </Tag>
            ) : (
              <>
                <Badge status="processing" />
                本地运行 · 127.0.0.1
              </>
            )}
          </span>
        </Layout.Header>
        {demo && (
          <Alert
            banner
            type="warning"
            showIcon
            message="演示模式"
            description="服务器、GPU、任务与同步均为本地生成的合成数据，不会连接任何真实机器。设置 SM_DEMO=1 启动即是此模式，去掉该变量即可回到真实模式。"
            style={{ borderRadius: 0 }}
          />
        )}
        <Layout.Content style={{ padding: 20, overflow: 'auto' }}>
          <div style={{ maxWidth: 1280, margin: '0 auto' }}>
            <Outlet />
          </div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}