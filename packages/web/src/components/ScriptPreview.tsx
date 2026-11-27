import { Alert, Space, Tabs } from 'antd';
import type { TargetPreview } from '@sm/shared';

export default function ScriptPreview({ preview }: { preview: TargetPreview }) {
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {preview.warnings.map((warning) => (
        <Alert key={warning} type="warning" showIcon message={warning} />
      ))}
      <Tabs
        size="small"
        items={[
          {
            key: 'command',
            label: '渲染后的命令',
            children: <pre className="sm-code-block">{preview.renderedCommand}</pre>,
          },
          {
            key: 'script',
            label: '完整脚本',
            children: <pre className="sm-code-block">{preview.scriptContent}</pre>,
          },
        ]}
      />
    </Space>
  );
}