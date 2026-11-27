import { Button, Result, Spin } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useServer } from '../../api/servers';
import ServerForm from './ServerForm';

export default function ServerFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const serverQuery = useServer(id);

  if (id && serverQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }

  if (id && serverQuery.isError) {
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

  return <ServerForm server={id ? serverQuery.data : undefined} />;
}