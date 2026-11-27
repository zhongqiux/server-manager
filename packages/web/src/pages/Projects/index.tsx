import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import type { ProjectDTO } from '@sm/shared';
import { useDeleteProject, useProjects } from '../../api/projects';
import { ApiError } from '../../api/client';
import { formatDateTime } from '../../utils/format';

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const projectsQuery = useProjects();
  const deleteMutation = useDeleteProject();

  const confirmDelete = (project: ProjectDTO) => {
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
          await deleteMutation.mutateAsync(project.id);
          message.success('项目已删除');
        } catch (err) {
          if (err instanceof ApiError) message.error(err.message);
          else message.error('删除失败');
        }
      },
    });
  };

  const columns: TableColumnsType<ProjectDTO> = [
    {
      title: '项目',
      key: 'name',
      width: 260,
      render: (_, project) => (
        <div>
          <Link to={`/projects/${project.id}`} style={{ fontWeight: 500 }}>
            {project.name}
          </Link>
          <div className="text-muted mono" style={{ fontSize: 12 }} title={project.localRoot}>
            {project.localRoot}
          </div>
        </div>
      ),
    },
    {
      title: '忽略规则',
      key: 'ignore',
      width: 110,
      render: (_, project) =>
        project.ignoreExtra.length > 0 ? (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            项目级 {project.ignoreExtra.length} 条
          </Tag>
        ) : (
          <span className="text-muted">仅默认</span>
        ),
    },
    {
      title: '目标',
      dataIndex: 'targetCount',
      width: 70,
      render: (value: number | undefined) => value ?? 0,
    },
    {
      title: '更新于',
      dataIndex: 'updatedAt',
      width: 150,
      render: (value: string) => <span className="text-muted">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_, project) => (
        <Space size={0} wrap>
          <Button type="link" size="small" onClick={() => navigate(`/projects/${project.id}`)}>
            详情
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/projects/${project.id}/edit`)}
          >
            编辑
          </Button>
          <Button type="link" size="small" danger onClick={() => confirmDelete(project)}>
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
          <h1 className="sm-page-title">项目</h1>
          <div className="sm-page-subtitle">本地代码目录、忽略规则与服务器绑定（Target）</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/projects/new')}>
          添加项目
        </Button>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={projectsQuery.isLoading}
          columns={columns}
          dataSource={projectsQuery.data ?? []}
          pagination={false}
          scroll={{ x: 900 }}
          locale={{
            emptyText: (
              <Empty description="还没有项目，先把本地代码目录添加进来">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/projects/new')}>
                  添加项目
                </Button>
              </Empty>
            ),
          }}
        />
      </Card>
    </div>
  );
}