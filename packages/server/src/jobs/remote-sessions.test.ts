import { describe, expect, it } from 'vitest';
import {
  buildRemoteSessionsCommand,
  parseRemoteSessionsOutput,
  parseScreenWindowsOutput,
} from './remote-sessions.ts';

describe('parseScreenWindowsOutput', () => {
  it('解析 screen 4.x 的窗口列表（双空格分隔、无换行）', () => {
    const windows = parseScreenWindowsOutput('0 bash  1 job title');
    expect(windows).toEqual([
      { id: '0', index: '0', name: 'bash', active: false, currentCommand: null },
      { id: '1', index: '1', name: 'job title', active: false, currentCommand: null },
    ]);
  });

  it('兼容当前/上次窗口标记与换行输出', () => {
    const windows = parseScreenWindowsOutput('0* bash  1- python train  2$ logs\n');
    expect(windows.map((item) => item.name)).toEqual(['bash', 'python train', 'logs']);
    expect(windows.map((item) => item.id)).toEqual(['0', '1', '2']);
  });

  it('空输出返回空数组', () => {
    expect(parseScreenWindowsOutput('')).toEqual([]);
    expect(parseScreenWindowsOutput('  \n')).toEqual([]);
  });
});

describe('parseRemoteSessionsOutput', () => {
  it('合并 tmux 与 screen 会话并按工具排序', () => {
    const stdout = [
      'TMUX_TOOL=1',
      'SM_TMWIN\tprotein\t@1\t1\ttrain\t1\tpython',
      'SM_TMWIN\tprotein\t@2\t2\tshell\t0\tbash',
      'SM_TMWIN\tlab\t@4\t1\tbash\t1\tbash',
      'SCREEN_TOOL=1',
      'SM_SCRWIN\taf2\t0 bash  1 logs',
      'SM_LIST_DONE=1',
    ].join('\n');
    const result = parseRemoteSessionsOutput(stdout);
    expect(result.tools).toEqual({ tmux: true, screen: true });
    expect(result.warnings).toEqual([]);
    expect(result.sessions.map((item) => `${item.tool}:${item.name}`)).toEqual([
      'tmux:lab',
      'tmux:protein',
      'screen:af2',
    ]);
    const protein = result.sessions.find((item) => item.name === 'protein');
    expect(protein?.windows).toEqual([
      { id: '@1', index: '1', name: 'train', active: true, currentCommand: 'python' },
      { id: '@2', index: '2', name: 'shell', active: false, currentCommand: 'bash' },
    ]);
    const af2 = result.sessions.find((item) => item.name === 'af2');
    expect(af2?.windows.map((item) => item.name)).toEqual(['bash', 'logs']);
  });

  it('工具存在但没有会话时给出提示', () => {
    const result = parseRemoteSessionsOutput('TMUX_TOOL=1\nSCREEN_TOOL=0\nSM_LIST_DONE=1\n');
    expect(result.tools).toEqual({ tmux: true, screen: false });
    expect(result.warnings).toContain('服务器上没有正在运行的 tmux / screen 会话');
  });

  it('缺少结束标记时提示结果可能不完整', () => {
    const result = parseRemoteSessionsOutput('TMUX_TOOL=1\nSM_TMWIN\tprotein\t@1\t1\ttrain\t1\tpython');
    expect(result.warnings).toContain('会话列表命令未正常结束，结果可能不完整');
    expect(result.sessions).toHaveLength(1);
  });

  it('忽略格式错误的窗口行', () => {
    const result = parseRemoteSessionsOutput(
      ['TMUX_TOOL=1', 'SM_TMWIN\tbroken', 'SM_SCRWIN\t', 'SM_LIST_DONE=1'].join('\n'),
    );
    expect(result.sessions).toEqual([]);
    expect(result.tools.tmux).toBe(true);
  });
});

describe('buildRemoteSessionsCommand', () => {
  it('探测工具并以标记行输出，便于一次 exec 解析', () => {
    const command = buildRemoteSessionsCommand();
    expect(command).toContain('command -v tmux');
    expect(command).toContain('command -v screen');
    expect(command).toContain('SM_TMWIN');
    expect(command).toContain('SM_SCRWIN');
    expect(command).toContain('-Q windows');
    expect(command).toContain("echo SM_LIST_DONE=1");
  });
});