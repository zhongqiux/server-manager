import { describe, expect, it } from 'vitest';
import {
  chooseJobLauncher,
  jobWindowName,
  normalizeSessionMode,
  normalizeSessionRequest,
  screenWindowCloseByTitleCommand,
  screenWindowIndexCommand,
  sessionCheckCommand,
  sessionCloseCommand,
  sessionInterruptCommand,
  sessionLaunchCommand,
  sessionNewWindowCommand,
  sessionPidCommand,
  sessionWindowCloseCommand,
  sessionWindowInterruptCommand,
  sessionWindowRunCommand,
} from './session.ts';

describe('chooseJobLauncher', () => {
  it('自动模式优先 tmux，其次 screen，否则 nohup', () => {
    expect(chooseJobLauncher('auto', { tmux: true, screen: true })).toBe('tmux');
    expect(chooseJobLauncher(undefined, { tmux: false, screen: true })).toBe('screen');
    expect(chooseJobLauncher('auto', { tmux: false, screen: false })).toBe('nohup');
  });

  it('显式选择缺失的会话工具时给出明确错误', () => {
    expect(() => chooseJobLauncher('tmux', { tmux: false, screen: true })).toThrow('未安装 tmux');
    expect(() => chooseJobLauncher('screen', { tmux: true, screen: false })).toThrow('未安装 screen');
    expect(chooseJobLauncher('nohup', { tmux: false, screen: false })).toBe('nohup');
  });
});

describe('screen 会话命令', () => {
  it('以分离会话启动脚本，结束后保留交互 shell', () => {
    const command = sessionLaunchCommand('screen', 'sm_test', '/tmp/job.sh');
    expect(command).toContain("screen -dmS 'sm_test'");
    expect(command).toContain('bash -c');
    expect(command).toContain('/tmp/job.sh');
    expect(command).toContain('exec bash');
  });

  it('探测会话存在并优先解析子进程 PID', () => {
    expect(sessionCheckCommand('screen', 'sm_test')).toContain("screen -ls");
    expect(sessionCheckCommand('screen', 'sm_test')).toContain('SESS=1');
    const pidCommand = sessionPidCommand('screen', 'sm_test');
    expect(pidCommand).toContain('ps -eo pid=,ppid=');
    expect(pidCommand).toContain('$2 == p');
  });

  it('优雅停止发送 Ctrl-C，随后退出 screen 会话', () => {
    expect(sessionInterruptCommand('screen', 'sm_test')).toContain('-X stuff');
    expect(sessionInterruptCommand('screen', 'sm_test')).toContain('\u0003');
    expect(sessionCloseCommand('screen', 'sm_test')).toContain('-X quit');
  });

  it('tmux 继续使用精确会话匹配与 pane PID', () => {
    expect(sessionCheckCommand('tmux', 'sm_test')).toContain("'=sm_test'");
    expect(sessionPidCommand('tmux', 'sm_test')).toContain('#{pane_pid}');
    expect(sessionInterruptCommand('tmux', 'sm_test')).toContain('C-c');
    expect(sessionCloseCommand('tmux', 'sm_test')).toContain('kill-session');
  });
});

describe('normalizeSessionRequest', () => {
  const jobId = '12345678-0000-4000-8000-000000000000';

  it('新建模式忽略会话字段', () => {
    const request = normalizeSessionRequest(jobId, {
      launcher: 'tmux',
      sessionMode: 'new',
      sessionName: 'should-ignore',
      windowId: '@9',
    });
    expect(request).toEqual({
      sessionMode: 'new',
      launcher: null,
      sessionName: null,
      windowId: null,
      windowName: null,
    });
  });

  it('已有会话必须在 tmux 与 screen 之间选择并提供会话名', () => {
    expect(() =>
      normalizeSessionRequest(jobId, { sessionMode: 'new_window', launcher: 'auto', sessionName: 'x' }),
    ).toThrow('必须选择 tmux 或 screen');
    expect(() =>
      normalizeSessionRequest(jobId, { sessionMode: 'new_window', launcher: 'tmux' }),
    ).toThrow('请选择已有会话');
  });

  it('新窗口自动生成带任务 ID 前缀的窗口名', () => {
    const request = normalizeSessionRequest(jobId, {
      sessionMode: 'new_window',
      launcher: 'tmux',
      sessionName: 'protein',
    });
    expect(request.sessionName).toBe('protein');
    expect(request.windowName).toBe(jobWindowName(jobId));
    expect(request.windowId).toBeNull();
  });

  it('已有窗口必须提供合法的窗口标识', () => {
    expect(() =>
      normalizeSessionRequest(jobId, {
        sessionMode: 'existing_window',
        launcher: 'tmux',
        sessionName: 'protein',
      }),
    ).toThrow('请选择已有窗口');
    expect(() =>
      normalizeSessionRequest(jobId, {
        sessionMode: 'existing_window',
        launcher: 'tmux',
        sessionName: 'protein',
        windowId: '5',
      }),
    ).toThrow('tmux 窗口标识不合法');
    expect(() =>
      normalizeSessionRequest(jobId, {
        sessionMode: 'existing_window',
        launcher: 'screen',
        sessionName: 'af2',
        windowId: '@2',
      }),
    ).toThrow('screen 窗口序号不合法');
    const request = normalizeSessionRequest(jobId, {
      sessionMode: 'existing_window',
      launcher: 'tmux',
      sessionName: 'protein',
      windowId: '@2',
      windowName: 'train',
    });
    expect(request.windowId).toBe('@2');
    expect(request.windowName).toBe('train');
  });

  it('旧数据缺少 session_mode 时回退为新建模式', () => {
    expect(normalizeSessionMode(null)).toBe('new');
    expect(normalizeSessionMode('existing_window')).toBe('existing_window');
  });
});

describe('已有会话的窗口命令', () => {
  it('tmux 新建窗口返回窗口 ID 并在脚本结束后保留 shell', () => {
    const command = sessionNewWindowCommand('tmux', 'protein', 'sm_abc', '/tmp/job.sh');
    expect(command).toContain('new-window');
    expect(command).toContain("'=protein'");
    expect(command).toContain("-n 'sm_abc'");
    expect(command).toContain("-P -F '#{window_id}'");
    expect(command).toContain('exec bash');
  });

  it('screen 新建窗口只作用于指定会话', () => {
    const command = sessionNewWindowCommand('screen', 'af2', 'sm_abc', '/tmp/job.sh');
    expect(command).toContain("screen -S 'af2' -X screen");
    expect(command).toContain("-t 'sm_abc'");
    expect(command).not.toContain('-X quit');
  });

  it('注入命令带闸门校验，超时后排队命令变成空操作', () => {
    const tmux = sessionWindowRunCommand('tmux', 'protein', '@3', '/tmp/job.sh', '/tmp/job.go');
    expect(tmux).toContain('if [ -f ');
    expect(tmux).toContain('/tmp/job.go');
    expect(tmux).toContain('/tmp/job.sh');
    expect(tmux).toContain('; fi');
    expect(tmux).toContain('send-keys');
    expect(tmux).toContain('Enter');

    const screen = sessionWindowRunCommand('screen', 'af2', '1', '/tmp/job.sh', '/tmp/job.go');
    expect(screen).toContain("screen -S 'af2' -p '1' -X stuff");
    expect(screen).toContain('if [ -f ');
  });

  it('中断与关闭只针对目标窗口，从不退出整个会话', () => {
    const tmuxInterrupt = sessionWindowInterruptCommand('tmux', 'protein', '@3');
    expect(tmuxInterrupt).toContain('send-keys');
    expect(tmuxInterrupt).toContain('C-c');

    const screenInterrupt = sessionWindowInterruptCommand('screen', 'af2', '1');
    expect(screenInterrupt).toContain('-p \'1\' -X stuff');

    const tmuxClose = sessionWindowCloseCommand('tmux', 'protein', '@3');
    expect(tmuxClose).toContain('kill-window');
    expect(tmuxClose).not.toContain('kill-session');

    const screenClose = sessionWindowCloseCommand('screen', 'af2', '1');
    expect(screenClose).toContain('-X kill');
    expect(screenClose).not.toContain('-X quit');
  });

  it('screen 通过窗口标题定位序号，供新建窗口后回查', () => {
    const command = screenWindowIndexCommand('af2', 'sm_abc');
    expect(command).toContain('-Q windows');
    expect(command).toContain('sm_abc');
    const closeByTitle = screenWindowCloseByTitleCommand('af2', 'sm_abc');
    expect(closeByTitle).toContain('-Q windows');
    expect(closeByTitle).toContain('-X kill');
    expect(closeByTitle).not.toContain('-X quit');
  });
});