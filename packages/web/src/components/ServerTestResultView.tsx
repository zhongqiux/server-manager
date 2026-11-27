import { Alert, Space, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import type { ServerTestResult, TestStepName } from '@sm/shared';
import CapsTags from './CapsTags';

const STEP_LABELS: Record<TestStepName, string> = {
  tcp: 'TCP 连通性',
  handshake: 'SSH 握手',
  auth: 'SSH 握手与认证',
  exec: '远程命令执行',
};

export default function ServerTestResultView({ result }: { result: ServerTestResult }) {
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      {result.ok ? (
        <Alert type="success" showIcon message={`连接成功 · 总耗时 ${result.latencyMs} ms`} />
      ) : (
        <Alert type="error" showIcon message={result.error?.message ?? '连接测试未通过'} />
      )}

      {result.hostKeyChanged && (
        <Alert
          type="warning"
          showIcon
          message="主机指纹与记录不一致"
          description={result.hostKeyFp ? `新指纹已记录：${result.hostKeyFp}` : undefined}
        />
      )}

      <div>
        {result.steps.map((step) => (
          <div key={step.name} style={{ display: 'flex', gap: 8, padding: '7px 0', alignItems: 'flex-start' }}>
            {step.ok ? (
              <CheckCircleFilled style={{ color: '#16a34a', marginTop: 3 }} />
            ) : (
              <CloseCircleFilled style={{ color: '#dc2626', marginTop: 3 }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13 }}>
                {STEP_LABELS[step.name]}{' '}
                <Typography.Text type="secondary" className="tabular-nums" style={{ fontSize: 12 }}>
                  {step.ms} ms
                </Typography.Text>
              </div>
              {step.message && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{step.message}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {result.caps && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            远程能力
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <CapsTags caps={result.caps} />
          </div>
        </div>
      )}

      {result.hostKeyFp && (
        <div style={{ fontSize: 12, color: '#64748b', wordBreak: 'break-all' }}>
          主机指纹：<span className="mono">{result.hostKeyFp}</span>
        </div>
      )}
    </Space>
  );
}