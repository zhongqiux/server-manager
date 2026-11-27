import { useNavigate, useParams } from 'react-router-dom';
import { Button, Result, Spin } from 'antd';
import { useProject } from '../../api/projects';
import { useTarget } from '../../api/targets';
import TargetForm from './TargetForm';

export default function TargetFormPage() {
  const { id = '', targetId } = useParams();
  const navigate = useNavigate();
  const projectQuery = useProject(id);
  const targetQuery = useTarget(targetId);

  if (projectQuery.isLoading || (targetId && targetQuery.isLoading)) {
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
        extra={
          <Button type="primary" onClick={() => navigate('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  if (targetId) {
    if (targetQuery.isError || !targetQuery.data || targetQuery.data.projectId !== id) {
      return (
        <Result
          status="404"
          title="目标不存在"
          extra={
            <Button type="primary" onClick={() => navigate(`/projects/${id}`)}>
              返回项目
            </Button>
          }
        />
      );
    }
    return <TargetForm project={projectQuery.data} target={targetQuery.data} />;
  }

  return <TargetForm project={projectQuery.data} />;
}