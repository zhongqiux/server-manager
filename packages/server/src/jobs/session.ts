import {
  shq,
  type JobInput,
  type JobLauncher,
  type JobLauncherPreference,
  type JobSessionMode,
} from '@sm/shared';

export type SessionLauncher = 'tmux' | 'screen';

export type SessionToolSupport = {
  tmux: boolean;
  screen: boolean;
};

export type SessionRequest = {
  sessionMode: JobSessionMode;
  launcher: SessionLauncher | null;
  sessionName: string | null;
  windowId: string | null;
  windowName: string | null;
};

export function isSessionLauncher(
  launcher: JobLauncher | string | null | undefined,
): launcher is SessionLauncher {
  return launcher === 'tmux' || launcher === 'screen';
}

export function normalizeSessionMode(value: string | null | undefined): JobSessionMode {
  return value === 'new_window' || value === 'existing_window' ? value : 'new';
}

export function normalizeSessionRequest(
  jobId: string,
  input: Pick<JobInput, 'launcher' | 'sessionMode' | 'sessionName' | 'windowId' | 'windowName'>,
): SessionRequest {
  const sessionMode = input.sessionMode ?? 'new';
  if (sessionMode === 'new') {
    return { sessionMode, launcher: null, sessionName: null, windowId: null, windowName: null };
  }
  const launcher = input.launcher;
  if (launcher !== 'tmux' && launcher !== 'screen') {
    throw new Error('使用已有会话时必须选择 tmux 或 screen');
  }
  const sessionName = input.sessionName?.trim();
  if (!sessionName) throw new Error('请选择已有会话');
  const windowId = sessionMode === 'existing_window' ? input.windowId?.trim() : undefined;
  if (sessionMode === 'existing_window' && !windowId) throw new Error('请选择已有窗口');
  if (windowId && launcher === 'tmux' && !/^@\d+$/.test(windowId)) {
    throw new Error('tmux 窗口标识不合法，请刷新会话列表后重试');
  }
  if (windowId && launcher === 'screen' && !/^\d+$/.test(windowId)) {
    throw new Error('screen 窗口序号不合法，请刷新会话列表后重试');
  }
  return {
    sessionMode,
    launcher,
    sessionName,
    windowId: windowId ?? null,
    windowName:
      sessionMode === 'new_window'
        ? jobWindowName(jobId)
        : (input.windowName?.trim().slice(0, 256) ?? null),
  };
}

export function chooseJobLauncher(
  preference: JobLauncherPreference | undefined,
  support: SessionToolSupport,
): JobLauncher {
  const wanted = preference ?? 'auto';
  if (wanted === 'auto') {
    if (support.tmux) return 'tmux';
    if (support.screen) return 'screen';
    return 'nohup';
  }
  if (wanted === 'tmux' && !support.tmux) {
    throw new Error('服务器未安装 tmux，无法使用 tmux 会话；请改选 screen 或 nohup');
  }
  if (wanted === 'screen' && !support.screen) {
    throw new Error('服务器未安装 screen，无法使用 screen 会话；请改选 tmux 或 nohup');
  }
  return wanted;
}

export function jobSessionName(jobId: string): string {
  return `sm_${jobId}`;
}

export function jobWindowName(jobId: string): string {
  return `sm_${jobId.replace(/-/g, '').slice(0, 8)}`;
}

export function sessionLaunchCommand(
  launcher: SessionLauncher,
  session: string,
  scriptPath: string,
): string {
  const inner = `bash ${shq(scriptPath)}; exec bash`;
  if (launcher === 'tmux') {
    return `tmux new-session -d -s ${shq(session)} -- bash -c ${shq(inner)} 2>&1`;
  }
  return `TERM=\${TERM:-xterm} screen -dmS ${shq(session)} bash -c ${shq(inner)} 2>&1`;
}

export function sessionCheckCommand(launcher: SessionLauncher, session: string): string {
  const condition =
    launcher === 'tmux'
      ? `command -v tmux >/dev/null 2>&1 && tmux has-session -t ${shq(`=${session}`)} 2>/dev/null`
      : `command -v screen >/dev/null 2>&1 && screen -ls 2>/dev/null | grep -Eq ${shq(
          `[0-9]+\\.${session}([[:space:]]|$)`,
        )}`;
  return `if ${condition}; then echo SESS=1; else echo SESS=0; fi`;
}

export function sessionNewWindowCommand(
  launcher: SessionLauncher,
  session: string,
  title: string,
  scriptPath: string,
): string {
  const inner = `bash ${shq(scriptPath)}; exec bash`;
  if (launcher === 'tmux') {
    return `tmux new-window -d -t ${shq(`=${session}`)} -n ${shq(title)} -P -F '#{window_id}' -- bash -c ${shq(inner)} 2>&1`;
  }
  return `TERM=\${TERM:-xterm} screen -S ${shq(session)} -X screen -t ${shq(title)} bash -c ${shq(inner)} 2>&1`;
}

export function screenWindowIndexCommand(session: string, title: string): string {
  return `screen -S ${shq(session)} -Q windows 2>/dev/null | tr -d '\\r' | grep -oE ${shq(
    `(^|  )[0-9]+ ${title}( |$)`,
  )} | head -n1 | sed -e 's/^ *//' -e 's/ .*//'`;
}

export function sessionWindowRunCommand(
  launcher: SessionLauncher,
  session: string,
  windowId: string,
  scriptPath: string,
  gatePath: string,
): string {
  const payload = `if [ -f ${shq(gatePath)} ]; then bash ${shq(scriptPath)}; fi`;
  if (launcher === 'tmux') {
    return `tmux send-keys -t ${shq(`${session}:${windowId}`)} ${shq(payload)} Enter 2>&1`;
  }
  return `screen -S ${shq(session)} -p ${shq(windowId)} -X stuff ${shq(`${payload}\n`)} 2>&1`;
}

export function sessionWindowInterruptCommand(
  launcher: SessionLauncher,
  session: string,
  windowId: string,
): string {
  if (launcher === 'tmux') {
    return `tmux send-keys -t ${shq(`${session}:${windowId}`)} C-c 2>/dev/null || true`;
  }
  return `screen -S ${shq(session)} -p ${shq(windowId)} -X stuff ${shq('\u0003')} 2>/dev/null || true`;
}

export function screenWindowInterruptByTitleCommand(session: string, title: string): string {
  return `IDX=$(${screenWindowIndexCommand(session, title)}); if [ -n "$IDX" ]; then screen -S ${shq(
    session,
  )} -p "$IDX" -X stuff ${shq('\u0003')} 2>/dev/null || true; fi`;
}

export function sessionWindowCloseCommand(
  launcher: SessionLauncher,
  session: string,
  windowId: string,
): string {
  if (launcher === 'tmux') {
    return `tmux kill-window -t ${shq(`${session}:${windowId}`)} 2>/dev/null || true`;
  }
  return `screen -S ${shq(session)} -p ${shq(windowId)} -X kill 2>/dev/null || true`;
}

export function screenWindowCloseByTitleCommand(session: string, title: string): string {
  return `IDX=$(${screenWindowIndexCommand(session, title)}); if [ -n "$IDX" ]; then screen -S ${shq(
    session,
  )} -p "$IDX" -X kill 2>/dev/null || true; fi`;
}

export function sessionPidCommand(launcher: SessionLauncher, session: string): string {
  if (launcher === 'tmux') {
    return `tmux list-panes -t ${shq(`=${session}`)} -F '#{pane_pid}' | head -n1`;
  }
  const sedScript = `s/^[[:space:]]*\\([0-9][0-9]*\\)\\.${session}[[:space:]].*/\\1/p`;
  const screenPid = `screen -ls 2>/dev/null | sed -n ${shq(sedScript)} | head -n1`;
  return `SP=$(${screenPid}); if [ -n "$SP" ]; then CP=$(ps -eo pid=,ppid= 2>/dev/null | awk -v p="$SP" '$2 == p { print $1; exit }'); if [ -n "$CP" ]; then printf '%s\\n' "$CP"; else printf '%s\\n' "$SP"; fi; fi`;
}

export function sessionInterruptCommand(launcher: SessionLauncher, session: string): string {
  if (launcher === 'tmux') {
    return `tmux send-keys -t ${shq(`=${session}`)} C-c 2>/dev/null || true`;
  }
  return `screen -S ${shq(session)} -p 0 -X stuff ${shq('\u0003')} 2>/dev/null || true`;
}

export function sessionCloseCommand(launcher: SessionLauncher, session: string): string {
  if (launcher === 'tmux') {
    return `tmux kill-session -t ${shq(`=${session}`)} 2>/dev/null || true`;
  }
  return `screen -S ${shq(session)} -X quit 2>/dev/null || true`;
}