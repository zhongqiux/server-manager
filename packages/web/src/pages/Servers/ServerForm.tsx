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
  InputNumber,
  Radio,
  Row,
  Select,
  Space,
} from 'antd';
import { ApiOutlined, ArrowLeftOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { AuthType, HostKeyPolicy, ServerDTO, ServerInput, ServerTestResult } from '@sm/shared';
import { ApiError } from '../../api/client';
import { useCreateServer, useTestDraft, useTestServer, useUpdateServer } from '../../api/servers';
import ServerTestResultView from '../../components/ServerTestResultView';

type FormValues = {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  hostKeyPolicy: HostKeyPolicy;
  tags?: string[];
  notes?: string;
};

function buildInput(values: FormValues): ServerInput {
  const input: ServerInput = {
    name: values.name.trim(),
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    authType: values.authType,
    hostKeyPolicy: values.hostKeyPolicy,
    tags: values.tags ?? [],
    notes: values.notes?.trim() ? values.notes.trim() : null,
  };
  if (values.authType === 'password') {
    if (values.password) input.password = values.password;
  } else {
    if (values.privateKey) input.privateKey = values.privateKey;
    if (values.passphrase) input.passphrase = values.passphrase;
  }
  return input;
}

export default function ServerForm({ server }: { server?: ServerDTO }) {
  const isEdit = Boolean(server);
  const [form] = Form.useForm<FormValues>();
  const authType = (Form.useWatch('authType', form) as AuthType | undefined) ?? 'password';
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const createMutation = useCreateServer();
  const updateMutation = useUpdateServer(server?.id ?? '');
  const testDraftMutation = useTestDraft();
  const testByIdMutation = useTestServer(server?.id ?? '');

  const [testResult, setTestResult] = useState<ServerTestResult | null>(null);
  const saving = createMutation.isPending || updateMutation.isPending;
  const testing = testDraftMutation.isPending || testByIdMutation.isPending;

  const initialValues: Partial<FormValues> = server
    ? {
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType,
        hostKeyPolicy: server.hostKeyPolicy,
        tags: server.tags,
        notes: server.notes ?? '',
      }
    : { port: 22, authType: 'password', hostKeyPolicy: 'tofu', tags: [], notes: '' };

  const handleSave = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    try {
      if (isEdit && server) {
        await updateMutation.mutateAsync(buildInput(values));
        message.success('已保存');
        navigate(`/servers/${server.id}`);
      } else {
        const created = await createMutation.mutateAsync(buildInput(values));
        message.success('服务器已添加，建议先测试连接');
        navigate(`/servers/${created.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('保存失败');
    }
  };

  const handleTest = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setTestResult(null);
    try {
      const result =
        isEdit && server
          ? await testByIdMutation.mutateAsync({
              host: values.host,
              port: values.port,
              username: values.username,
              authType: values.authType,
              hostKeyPolicy: values.hostKeyPolicy,
              ...(values.password ? { password: values.password } : {}),
              ...(values.privateKey ? { privateKey: values.privateKey } : {}),
              ...(values.passphrase ? { passphrase: values.passphrase } : {}),
            })
          : await testDraftMutation.mutateAsync(buildInput(values));
      setTestResult(result);
      if (result.ok) message.success(`连接成功（${result.latencyMs} ms）`);
      else message.warning(result.error?.message ?? '连接测试未通过');
    } catch (err) {
      if (err instanceof ApiError) message.error(err.message);
      else message.error('连接测试失败');
    }
  };

  return (
    <div>
      <div className="sm-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} />
          <div>
            <h1 className="sm-page-title">{isEdit ? '编辑服务器' : '添加服务器'}</h1>
            <div className="sm-page-subtitle">
              {isEdit ? '留空的凭据字段表示保持原值不变' : '保存 SSH 连接信息，凭据将加密存储在本机'}
            </div>
          </div>
        </div>
      </div>

      <Card style={{ maxWidth: 920 }}>
        <Form form={form} layout="vertical" initialValues={initialValues} requiredMark="optional">
          <Row gutter={16}>
            <Col xs={24} md={14}>
              <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                <Input placeholder="如：实验室 4090-8 卡机" maxLength={64} />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item name="tags" label="标签">
                <Select mode="tags" placeholder="如：4090 / 内网 / 组内共享" tokenSeparators={[',', '，']} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={16}>
              <Form.Item
                name="host"
                label="主机地址"
                rules={[{ required: true, message: '请输入主机名或 IP' }]}
              >
                <Input placeholder="10.0.0.12 或 gpu-lab-01" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="port" label="SSH 端口" rules={[{ required: true, message: '请输入端口' }]}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={14}>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input placeholder="如：zhangsan" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item name="authType" label="认证方式" rules={[{ required: true }]}>
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="password">密码</Radio.Button>
                  <Radio.Button value="key">私钥</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Col>
          </Row>

          {authType === 'password' ? (
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: !isEdit, message: '请填写密码' }]}
              extra={isEdit ? '留空表示保持原有密码不变' : undefined}
            >
              <Input.Password
                placeholder={isEdit ? '留空保持原密码' : 'SSH 登录密码'}
                autoComplete="new-password"
              />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name="privateKey"
                label="私钥内容"
                rules={[{ required: !isEdit, message: '请粘贴私钥内容' }]}
                extra={isEdit ? '留空表示保持原有私钥不变' : '支持 OpenSSH / PEM 格式，保存时使用本机主密钥加密'}
              >
                <Input.TextArea
                  rows={5}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
                />
              </Form.Item>
              <Form.Item name="passphrase" label="私钥口令（可选）" extra={isEdit ? '留空表示保持原口令' : undefined}>
                <Input.Password placeholder="私钥无口令可留空" autoComplete="new-password" />
              </Form.Item>
            </>
          )}

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="hostKeyPolicy" label="主机指纹策略">
                <Select
                  options={[
                    { value: 'tofu', label: '首次信任并记录（推荐）' },
                    { value: 'strict', label: '严格校验（指纹变化时拒绝）' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="当前主机指纹">
                <span className="mono" style={{ fontSize: 12, color: server?.hostKeyFp ? '#166534' : '#64748b' }}>
                  {server?.hostKeyFp ?? '尚未记录（测试连接后写入）'}
                </span>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} placeholder="用途、归属、注意事项…" maxLength={4000} />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              isEdit
                ? '测试连接会使用当前表单内容（含未保存的修改），不会修改已保存的凭据。'
                : '连接测试只验证连通性，不会保存服务器；保存后凭据会加密写入本地数据库。'
            }
          />

          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              {isEdit ? '保存修改' : '保存服务器'}
            </Button>
            <Button icon={<ApiOutlined />} loading={testing} onClick={handleTest}>
              测试连接
            </Button>
            <Button onClick={() => navigate(-1)}>取消</Button>
          </Space>
        </Form>
      </Card>

      <Drawer
        title="连接测试结果"
        width={480}
        open={testResult !== null}
        onClose={() => setTestResult(null)}
      >
        {testResult && <ServerTestResultView result={testResult} />}
      </Drawer>
    </div>
  );
}