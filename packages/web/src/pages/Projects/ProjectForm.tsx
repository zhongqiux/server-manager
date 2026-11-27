import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  Radio,
  Space,
} from 'antd';
import { ArrowLeftOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { ProjectDTO, ProjectInput } from '@sm/shared';
import { DEFAULT_IGNORE_PATTERNS } from '@sm/shared';
import { ApiError } from '../../api/client';
import { useCreateProject, useUpdateProject } from '../../api/projects';

type FormValues = {
  name: string;
  localRoot: string;
  execBitPolicy: 'auto' | 'all755';
  ignoreExtra?: string;
};

function buildInput(values: FormValues): ProjectInput {
  return {
    name: values.name.trim(),
    localRoot: values.localRoot.trim(),
    execBitPolicy: values.execBitPolicy,
    ignoreExtra: (values.ignoreExtra ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

export default function ProjectForm({ project }: { project?: ProjectDTO }) {
  const isEdit = Boolean(project);
  const [form] = Form.useForm<FormValues>();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const createMutation = useCreateProject();
  const updateMutation = useUpdateProject(project?.id ?? '');
  const saving = createMutation.isPending || updateMutation.isPending;

  const initialValues: Partial<FormValues> = project
    ? {
        name: project.name,
        localRoot: project.localRoot,
        execBitPolicy: project.execBitPolicy,
        ignoreExtra: project.ignoreExtra.join('\n'),
      }
    : { execBitPolicy: 'auto', ignoreExtra: '' };

  const handleSave = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    try {
      if (isEdit && project) {
        await updateMutation.mutateAsync(buildInput(values));
        message.success('项目已保存');
        navigate(`/projects/${project.id}`);
      } else {
        const created = await createMutation.mutateAsync(buildInput(values));
        message.success('项目已添加，现在可以为它绑定服务器目标');
        navigate(`/projects/${created.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('保存失败');
    }
  };

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} />
          <div>
            <h1 className="sm-page-title">{isEdit ? '编辑项目' : '添加项目'}</h1>
            <div className="sm-page-subtitle">本地代码根目录与同步忽略规则</div>
          </div>
        </div>
      </div>

      <Card style={{ maxWidth: 920 }}>
        <Form form={form} layout="vertical" initialValues={initialValues} requiredMark="optional">
          <Form.Item
            name="name"
            label="项目名称"
            rules={[{ required: true, message: '请输入项目名称' }]}
          >
            <Input placeholder="如：扩散模型训练" maxLength={64} />
          </Form.Item>

          <Form.Item
            name="localRoot"
            label="本地代码目录"
            rules={[{ required: true, message: '请填写本地目录' }]}
            extra="绝对路径。同步时只传输此目录下的代码；数据目录请在各服务器的 Target 中单独配置，不会同步。"
          >
            <Input placeholder="D:\\code\\my-project" className="mono" />
          </Form.Item>

          <Form.Item name="execBitPolicy" label="可执行位策略">
            <Radio.Group>
              <Radio value="auto">跟随本地文件权限（推荐）</Radio>
              <Radio value="all755">全部文件设为 755</Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            name="ignoreExtra"
            label="项目级忽略规则（每行一条）"
            extra={
              <>
                使用 gitignore 语法，例如 <code>*.ipynb</code>、<code>checkpoints/</code>、
                <code>!keep.log</code>。已内置默认规则 {DEFAULT_IGNORE_PATTERNS.length} 条（.git、node_modules、
                __pycache__、/data/ 等），硬黑名单（.git/、.sm-tmp-*）不可取消。
              </>
            }
          >
            <Input.TextArea rows={6} placeholder={'*.ipynb\ncheckpoints/\n!important.log'} />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="同步只传代码与配置；数据集、模型权重等大文件请放在各服务器独立的 data 目录，通过命令模板中的 {{data_dir}} 引用。"
          />

          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              {isEdit ? '保存修改' : '保存项目'}
            </Button>
            <Button onClick={() => navigate(-1)}>取消</Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}