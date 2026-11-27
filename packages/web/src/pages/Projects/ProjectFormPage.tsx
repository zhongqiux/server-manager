import { useNavigate, useParams } from 'react-router-dom';
import { Button, Result, Spin } from 'antd';
import { useProject } from '../../api/projects';
import ProjectForm from './ProjectForm';

export default function ProjectFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const projectQuery = useProject(id);

  if (id) {
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
    return <ProjectForm project={projectQuery.data} />;
  }

  return <ProjectForm />;
}