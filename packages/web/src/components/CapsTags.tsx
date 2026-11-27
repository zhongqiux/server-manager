import { Space, Tag, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import type { Caps } from '@sm/shared';

export default function CapsTags({ caps }: { caps: Caps }) {
  const tmuxVersion = caps.tmuxVersion?.replace(/^tmux\s*/, '');
  const screenVersion = caps.screenVersion
    ?.replace(/^Screen version\s*/i, '')
    .split(/\s+/)[0];
  const tags: ReactNode[] = [
    <Tag key="nvidia" color={caps.nvidiaSmi ? 'green' : undefined}>
      {caps.nvidiaSmi ? 'GPU 监控' : '无 nvidia-smi'}
    </Tag>,
    <Tag key="tmux" color={caps.tmux ? 'blue' : undefined}>
      {caps.tmux ? `tmux ${tmuxVersion ?? ''}`.trim() : '无 tmux'}
    </Tag>,
    <Tag key="screen" color={caps.screen ? 'blue' : undefined}>
      {caps.screen ? `screen ${screenVersion ?? ''}`.trim() : '无 screen'}
    </Tag>,
    <Tag key="git" color={caps.git ? 'blue' : undefined}>
      {caps.git ? (caps.gitVersion ?? 'git') : '无 git'}
    </Tag>,
    <Tag key="conda" color={caps.conda ? 'blue' : undefined}>
      {caps.conda ? 'conda' : '无 conda'}
    </Tag>,
    <Tooltip key="find" title="远程清单采集方式">
      <Tag>find: {caps.find ?? 'unknown'}</Tag>
    </Tooltip>,
    <Tooltip key="stat" title="文件状态采集方式">
      <Tag>stat: {caps.stat ?? 'unknown'}</Tag>
    </Tooltip>,
    <Tooltip key="tail" title="日志增量读取方式">
      <Tag>tail: {caps.tail ?? 'unknown'}</Tag>
    </Tooltip>,
  ];
  return (
    <Space size={[4, 4]} wrap>
      {tags}
    </Space>
  );
}