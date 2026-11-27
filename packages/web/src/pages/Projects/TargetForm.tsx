import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
} from 'antd';
import {
  ArrowLeftOutlined,
  EyeOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { ProjectDTO, SyncMode, TargetDTO, TargetInput, TargetPreview } from '@sm/shared';
import { ApiError } from '../../api/client';
import { useServers } from '../../api/servers';
import { useCreateTarget, usePreviewTargetDraft, useUpdateTarget } from '../../api/targets';
import ScriptPreview from '../../components/ScriptPreview';
import ServerStatusTag from '../../components/ServerStatusTag';

type EnvRow = { key?: string; value?: string };

type FormValues = {
  serverId: string;
  label?: string;
  syncMode: SyncMode;
  keepSession?: boolean;
  remoteCodeDir: string;
  dataDir?: string;
  gpuDevices?: string;
  condaEnv?: string;
  envVars?: EnvRow[];
  preCommand?: string;
  runCommand: string;
  extraIgnores?: string;
  mirrorDelete?: boolean;
  protectGlobs?: string;
  remoteUrl?: string;
  branch?: string;
  autoCommitOnSource?: boolean;
};

function buildInput(projectId: string, values: FormValues, target?: TargetDTO): TargetInput {
  const envVars: Record<string, string> = {};
  for (const row of values.envVars ?? []) {
    const key = row.key?.trim();
    if (key) envVars[key] = row.value ?? '';
  }
  const extraIgnores = (values.extraIgnores ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const protectGlobs = (values.protectGlobs ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const syncConfig: TargetInput['syncConfig'] = {
    ...(target?.syncConfig ?? {}),
    extraIgnores,
    mirrorDelete: Boolean(values.mirrorDelete),
    protectGlobs,
    ...(values.syncMode === 'git'
      ? {
          remoteUrl: values.remoteUrl?.trim() ?? '',
          branch: values.branch?.trim() || 'main',
          autoCommitOnSource: values.autoCommitOnSource ?? true,
        }
      : {}),
  };
  return {
    projectId,
    serverId: values.serverId,
    label: values.label?.trim() || null,
    remoteCodeDir: values.remoteCodeDir.trim(),
    dataDir: values.dataDir?.trim() || null,
    condaEnv: values.condaEnv?.trim() || null,
    gpuDevices: values.gpuDevices?.trim() || null,
    envVars,
    preCommand: values.preCommand?.trim() || null,
    runCommand: values.runCommand.trim(),
    syncMode: values.syncMode,
    syncConfig,
    keepSession: Boolean(values.keepSession),
  };
}

export default function TargetForm({ project, target }: { project: ProjectDTO; target?: TargetDTO }) {
  const isEdit = Boolean(target);
  const [form] = Form.useForm<FormValues>();
  const syncMode = (Form.useWatch('syncMode', form) as SyncMode | undefined) ?? 'sftp';
  const mirrorDelete = Boolean(Form.useWatch('mirrorDelete', form));
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const serversQuery = useServers();
  const createMutation = useCreateTarget();
  const updateMutation = useUpdateTarget(target?.id ?? '');
  const previewMutation = usePreviewTargetDraft();
  const [preview, setPreview] = useState<TargetPreview | null>(null);

  const servers = serversQuery.data ?? [];
  const saving = createMutation.isPending || updateMutation.isPending;

  const initialValues: Partial<FormValues> = target
    ? {
        serverId: target.serverId,
        label: target.label ?? '',
        syncMode: target.syncMode,
        keepSession: target.keepSession,
        remoteCodeDir: target.remoteCodeDir,
        dataDir: target.dataDir ?? '',
        gpuDevices: target.gpuDevices ?? '',
        condaEnv: target.condaEnv ?? '',
        envVars: Object.entries(target.envVars).map(([key, value]) => ({ key, value })),
        preCommand: target.preCommand ?? '',
        runCommand: target.runCommand,
        extraIgnores: (target.syncConfig.extraIgnores ?? []).join('\n'),
        mirrorDelete: target.syncConfig.mirrorDelete ?? false,
        protectGlobs: (target.syncConfig.protectGlobs ?? []).join('\n'),
        remoteUrl: target.syncConfig.remoteUrl ?? '',
        branch: target.syncConfig.branch ?? 'main',
        autoCommitOnSource: target.syncConfig.autoCommitOnSource ?? true,
      }
    : {
        syncMode: 'sftp',
        keepSession: false,
        envVars: [],
        extraIgnores: '',
        mirrorDelete: false,
        protectGlobs: '',
        branch: 'main',
        autoCommitOnSource: true,
      };

  const handleSave = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    try {
      const input = buildInput(project.id, values, target);
      if (isEdit && target) {
        await updateMutation.mutateAsync(input);
        message.success('目标已保存');
      } else {
        await createMutation.mutateAsync(input);
        message.success('目标已添加');
      }
      navigate(`/projects/${project.id}`);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('保存失败');
    }
  };

  const handlePreview = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    try {
      const result = await previewMutation.mutateAsync(buildInput(project.id, values, target));
      setPreview(result);
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('脚本预览失败');
    }
  };

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/projects/${project.id}`)} />
          <div>
            <h1 className="sm-page-title">{isEdit ? '编辑目标' : '添加目标'}</h1>
            <div className="sm-page-subtitle">
              项目「{project.name}」× 服务器；每个项目在同一台服务器上只能有一个目标
            </div>
          </div>
        </div>
      </div>

      <Card style={{ maxWidth: 1000 }}>
        <Form form={form} layout="vertical" initialValues={initialValues} requiredMark="optional">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="serverId"
                label="服务器"
                rules={[{ required: true, message: '请选择服务器' }]}
              >
                <Select
                  disabled={isEdit}
                  placeholder={servers.length ? '选择运行实验的服务器' : '请先添加服务器'}
                  options={servers.map((server) => ({
                    value: server.id,
                    label: `${server.name}（${server.username}@${server.host}）`,
                  }))}
                  optionRender={(option) => {
                    const server = servers.find((item) => item.id === option.value);
                    return (
                      <Space size={8}>
                        <span>{server ? `${server.name}（${server.username}@${server.host}）` : option.label}</span>
                        {server && <ServerStatusTag status={server.status} />}
                      </Space>
                    );
                  }}
                  notFoundContent="还没有服务器，请先到「服务器」页面添加"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="label" label="目标别名">
                <Input placeholder="如：4090 训练机 / A100 集群" maxLength={64} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={10}>
              <Form.Item name="syncMode" label="同步模式">
                <Segmented
                  options={[
                    { value: 'sftp', label: 'SFTP 增量（推荐）' },
                    { value: 'git', label: 'Git 中心仓库' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="tmux / screen 会话保留" name="keepSession" valuePropName="checked">
                <Switch checkedChildren="保留" unCheckedChildren="结束即关闭" />
              </Form.Item>
            </Col>
          </Row>

          {syncMode === 'git' && (
            <Row gutter={16}>
              <Col xs={24} md={14}>
                <Form.Item
                  name="remoteUrl"
                  label="中心仓库地址"
                  rules={[{ required: true, message: 'Git 模式需要填写仓库地址' }]}
                >
                  <Input className="mono" placeholder="git@github.com:me/project.git 或 https://..." />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item name="branch" label="分支">
                  <Input placeholder="main" />
                </Form.Item>
              </Col>
              <Col xs={24} md={5}>
                <Form.Item label="自动提交" name="autoCommitOnSource" valuePropName="checked">
                  <Switch checkedChildren="是" unCheckedChildren="否" />
                </Form.Item>
              </Col>
            </Row>
          )}

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="remoteCodeDir"
                label="远程代码目录"
                rules={[{ required: true, message: '请填写远程代码目录' }]}
                extra="绝对路径，深度至少两层。例如 /home/me/project"
              >
                <Input className="mono" placeholder="/home/me/project" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="dataDir"
                label="远程数据目录"
                extra="可选。数据集/模型权重放这里，不会参与同步"
              >
                <Input className="mono" placeholder="/mnt/data/project" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="condaEnv" label="conda 环境">
                <Input placeholder="如：torch2.4" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="gpuDevices" label="GPU 设备（CUDA_VISIBLE_DEVICES）">
                <Input className="mono" placeholder="如：0,1 或 2" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="extraIgnores" label="目标级额外忽略规则（每行一条）" extra="在上传前应用于此目标">
                <Input.TextArea rows={2} placeholder={'checkpoints/\n*.h5'} />
              </Form.Item>
            </Col>
          </Row>

          {syncMode === 'sftp' && (
            <>
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item
                    label="镜像删除"
                    name="mirrorDelete"
                    valuePropName="checked"
                    extra="默认关闭。开启后真实同步需输入目标名确认"
                  >
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={16}>
                  <Form.Item
                    name="protectGlobs"
                    label="删除保护规则（每行一条）"
                    extra="gitignore 语法；命中的远端文件即使本地不存在也不会被删除"
                  >
                    <Input.TextArea rows={2} placeholder={'checkpoints/\n*.pt'} />
                  </Form.Item>
                </Col>
              </Row>
              {mirrorDelete && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="镜像删除会删除远端代码目录中的多余文件；.git、数据目录、忽略规则与保护规则命中的文件始终受保护。"
                />
              )}
            </>
          )}

          <Form.Item label="环境变量">
            <Form.List name="envVars">
              {(fields, { add, remove }) => (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" style={{ display: 'flex' }}>
                      <Form.Item
                        name={[field.name, 'key']}
                        rules={[
                          { required: true, message: '变量名必填' },
                          { pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, message: '变量名不合法' },
                        ]}
                        style={{ marginBottom: 0 }}
                      >
                        <Input className="mono" placeholder="WANDB_API_KEY" style={{ width: 220 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'value']} style={{ marginBottom: 0 }}>
                        <Input className="mono" placeholder="值" style={{ width: 380 }} />
                      </Form.Item>
                      <MinusCircleOutlined onClick={() => remove(field.name)} />
                    </Space>
                  ))}
                  <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })}>
                    添加环境变量
                  </Button>
                </Space>
              )}
            </Form.List>
          </Form.Item>

          <Form.Item name="preCommand" label="前置命令">
            <Input.TextArea rows={2} placeholder="如：export OMP_NUM_THREADS=8" className="mono" />
          </Form.Item>

          <Form.Item
            name="runCommand"
            label="运行命令模板"
            rules={[{ required: true, message: '请填写运行命令' }]}
            extra="可用占位符：{{remote_dir}} {{data_dir}} {{project_name}} {{server_name}} {{gpu_devices}} {{job_id}}"
          >
            <Input.TextArea
              rows={3}
              className="mono"
              placeholder={'python train.py --data {{data_dir}} --out {{remote_dir}}/runs'}
            />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="执行时脚本会先 cd 到远程代码目录，再激活 conda 环境、注入环境变量，最后运行渲染后的命令。点击「预览脚本」可查看完整内容。"
          />

          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              {isEdit ? '保存修改' : '保存目标'}
            </Button>
            <Button icon={<EyeOutlined />} loading={previewMutation.isPending} onClick={handlePreview}>
              预览脚本
            </Button>
            <Button onClick={() => navigate(`/projects/${project.id}`)}>取消</Button>
          </Space>
        </Form>
      </Card>

      <Drawer title="脚本预览" width={680} open={preview !== null} onClose={() => setPreview(null)}>
        {preview && <ScriptPreview preview={preview} />}
      </Drawer>
    </div>
  );
}