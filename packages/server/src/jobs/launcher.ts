import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'ssh2';
import {
  shq,
  type JobLauncher,
  type JobLauncherPreference,
} from '@sm/shared';
import { TMP_DIR } from '../config.ts';
import { createLogger } from '../logger.ts';
import { getProjectRow } from '../services/projects.ts';
import { getJobRow, transitionJob, appendJobEvent, updateJob, type JobRow } from '../services/jobs.ts';
import { getServerConnectConfig, getServerRow } from '../services/servers.ts';
import { getTargetRow } from '../services/targets.ts';
import { runExec } from '../transport/ssh/exec.ts';
import { withClient } from '../transport/ssh/pool.ts';
import { openSftp, sftpUploadFile } from '../transport/ssh/sftp.ts';
import { buildJobScript } from './script.ts';
import { parseScreenWindowsOutput } from './remote-sessions.ts';
import {
  chooseJobLauncher,
  isSessionLauncher,
  jobSessionName,
  jobWindowName,
  normalizeSessionMode,
  screenWindowCloseByTitleCommand,
  screenWindowIndexCommand,
  sessionCheckCommand,
  sessionCloseCommand,
  sessionLaunchCommand,
  sessionNewWindowCommand,
  sessionWindowCloseCommand,
  sessionWindowRunCommand,
  type SessionLauncher,
} from './session.ts';

const log = createLogger('job-launch');

export type JobPaths = {
  home: string;
  scriptPath: string;
  logPath: string;
  exitPath: string;
  pidPath: string;
  gatePath: string;
};

export function buildJobPaths(home: string, jobId: string): JobPaths {
  const base = `${home.replace(/\/+$/, '')}/.server_manager`;
  return {
    home,
    scriptPath: `${base}/jobs/${jobId}.sh`,
    logPath: `${base}/logs/${jobId}.log`,
    exitPath: `${base}/jobs/${jobId}.exit`,
    pidPath: `${base}/jobs/${jobId}.pid`,
    gatePath: `${base}/jobs/${jobId}.go`,
  };
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function hardwareHome(serverId: string): string | null {
  const row = getServerRow(serverId);
  const hardware = parseJson<{ home?: string | null } | null>(row?.hw_json ?? null, null);
  const home = hardware?.home?.trim();
  return home && home.startsWith('/') ? home.replace(/\/+$/, '') : null;
}

async function resolveHome(client: Client, job: JobRow): Promise<string> {
  const cached = hardwareHome(job.server_id);
  if (cached) return cached;
  const result = await runExec(client, 'printf "%s" "$HOME"', { timeoutMs: 8000, maxBytes: 4096 });
  const home = result.stdout.trim();
  if (!home.startsWith('/') || home === '/') {
    throw new Error(`无法解析远程用户目录（返回「${home || '空'}」）`);
  }
  return home.replace(/\/+$/, '');
}

async function detectTools(client: Client): Promise<{ bash: boolean; tmux: boolean; screen: boolean }> {
  const result = await runExec(
    client,
    'command -v bash >/dev/null 2>&1 && echo BASH=1 || echo BASH=0; command -v tmux >/dev/null 2>&1 && echo TMUX=1 || echo TMUX=0; command -v screen >/dev/null 2>&1 && echo SCREEN=1 || echo SCREEN=0',
    { timeoutMs: 10_000, maxBytes: 4096 },
  );
  return {
    bash: /BASH=1/.test(result.stdout),
    tmux: /TMUX=1/.test(result.stdout),
    screen: /SCREEN=1/.test(result.stdout),
  };
}

async function readPgid(client: Client, pid: number): Promise<number | null> {
  const result = await runExec(
    client,
    `ps -o pgid= -p ${pid} 2>/dev/null | tr -d ' '`,
    { timeoutMs: 8000, maxBytes: 4096 },
  );
  const value = result.stdout.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

async function readPid(client: Client, command: string): Promise<number | null> {
  const result = await runExec(client, command, { timeoutMs: 10_000, maxBytes: 4096 });
  const match = /SM_PID=(\d+)/.exec(result.stdout);
  return match ? Number(match[1]) : null;
}

function parseJobPid(text: string): { pid: number; pgid: number | null } | null {
  const match = /^(\d+)(?:\s+(\d+))?\s*$/.exec(text.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const pgid = match[2] ? Number(match[2]) : null;
  return Number.isFinite(pid) && pid > 0 ? { pid, pgid } : null;
}

function rowSessionMode(job: JobRow) {
  return normalizeSessionMode(job.session_mode);
}

async function readJobPid(
  client: Client,
  pidPath: string,
): Promise<{ pid: number; pgid: number | null } | null> {
  const result = await runExec(
    client,
    `if [ -f ${shq(pidPath)} ]; then cat ${shq(pidPath)}; fi`,
    { timeoutMs: 8000, maxBytes: 4096 },
  );
  return parseJobPid(result.stdout);
}

async function waitForJobPid(
  client: Client,
  pidPath: string,
  timeoutMs = 8000,
): Promise<{ pid: number; pgid: number | null } | null> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 1000));
  const command = [
    'i=0',
    `while [ "$i" -lt ${attempts} ]; do`,
    `  if [ -f ${shq(pidPath)} ]; then cat ${shq(pidPath)}; exit 0; fi`,
    '  i=$((i+1))',
    '  sleep 1',
    'done',
    'exit 0',
  ].join('\n');
  const result = await runExec(client, command, {
    timeoutMs: timeoutMs + 6000,
    maxBytes: 4096,
  });
  const parsed = parseJobPid(result.stdout);
  if (!parsed) return null;
  if (parsed.pgid) return parsed;
  return { pid: parsed.pid, pgid: await readPgid(client, parsed.pid) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchDedicatedSession(
  client: Client,
  launcher: SessionLauncher,
  jobId: string,
  scriptPath: string,
): Promise<string> {
  const session = jobSessionName(jobId);
  const result = await runExec(client, sessionLaunchCommand(launcher, session, scriptPath), {
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(
      `${launcher} 启动失败：${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}`,
    );
  }
  await sleep(300);
  const verify = await runExec(client, sessionCheckCommand(launcher, session), {
    timeoutMs: 10_000,
    maxBytes: 4096,
  });
  if (!/SESS=1/.test(verify.stdout)) {
    throw new Error(`${launcher} 会话启动后立即消失，日志可能包含 bash 语法或路径错误`);
  }
  return session;
}

async function readScreenWindows(client: Client, session: string) {
  const result = await runExec(
    client,
    `screen -S ${shq(session)} -Q windows 2>/dev/null || true`,
    { timeoutMs: 10_000, maxBytes: 64 * 1024 },
  );
  return parseScreenWindowsOutput(result.stdout);
}

async function findScreenWindowIndex(
  client: Client,
  session: string,
  title: string,
): Promise<string | null> {
  const result = await runExec(client, screenWindowIndexCommand(session, title), {
    timeoutMs: 10_000,
    maxBytes: 4096,
  });
  const value = result.stdout.trim();
  return /^\d+$/.test(value) ? value : null;
}

async function findTmuxWindowIdByTitle(
  client: Client,
  session: string,
  title: string,
): Promise<string | null> {
  const result = await runExec(
    client,
    `tmux list-windows -t ${shq(`=${session}`)} -F '#{window_id}	#{window_name}' 2>/dev/null || true`,
    { timeoutMs: 10_000, maxBytes: 64 * 1024 },
  );
  for (const line of result.stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    if (line.slice(tab + 1).trim() === title) return line.slice(0, tab).trim();
  }
  return null;
}

const SHELL_COMMANDS = new Set([
  'bash',
  'zsh',
  'sh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
]);

async function verifyExistingWindow(
  client: Client,
  launcher: SessionLauncher,
  session: string,
  windowId: string | null,
  windowName: string | null,
): Promise<void> {
  if (!windowId) throw new Error('缺少目标窗口标识，请刷新会话列表后重试');
  if (launcher === 'tmux') {
    const result = await runExec(
      client,
      `tmux list-windows -t ${shq(`=${session}`)} -F '#{window_id}	#{pane_current_command}' 2>/dev/null || true`,
      { timeoutMs: 10_000, maxBytes: 64 * 1024 },
    );
    const line = result.stdout
      .split(/\r?\n/)
      .find((item) => item.startsWith(`${windowId}\t`));
    if (!line) throw new Error('目标 tmux 窗口已不存在，请刷新会话列表');
    const command = line.slice(line.indexOf('\t') + 1).trim();
    const commandName = (command.split('/').pop() ?? command).replace(/^-/, '');
    if (command && !SHELL_COMMANDS.has(commandName)) {
      throw new Error(
        `目标 tmux 窗口正在运行「${command}」，为避免误输入命令已停止；请选择空闲窗口或使用“新开窗口”`,
      );
    }
    return;
  }
  const windows = await readScreenWindows(client, session);
  const found = windows.find((item) => item.id === windowId);
  if (!found) throw new Error('目标 screen 窗口已不存在，请刷新会话列表');
  if (windowName && found.name !== windowName) {
    throw new Error('screen 窗口序号已指向其他窗口，请刷新会话列表后重试');
  }
}

async function closeLaunchedWindow(
  client: Client,
  launcher: SessionLauncher,
  session: string,
  windowId: string | null,
  windowName: string | null,
): Promise<void> {
  try {
    if (launcher === 'tmux' && windowId) {
      await runExec(client, sessionWindowCloseCommand(launcher, session, windowId), {
        timeoutMs: 8000,
        maxBytes: 4096,
      });
    } else if (launcher === 'screen' && windowName) {
      await runExec(client, screenWindowCloseByTitleCommand(session, windowName), {
        timeoutMs: 8000,
        maxBytes: 4096,
      });
    } else if (launcher === 'screen' && windowId) {
      await runExec(client, sessionWindowCloseCommand(launcher, session, windowId), {
        timeoutMs: 8000,
        maxBytes: 4096,
      });
    }
  } catch {
    // 窗口可能已不存在
  }
}

async function launchNohup(
  client: Client,
  scriptPath: string,
): Promise<{ pid: number | null; pgid: number | null }> {
  const command = [
    `if command -v setsid >/dev/null 2>&1; then`,
    `  setsid nohup bash ${shq(scriptPath)} >/dev/null 2>&1 < /dev/null &`,
    `else`,
    `  nohup bash ${shq(scriptPath)} >/dev/null 2>&1 < /dev/null &`,
    `fi`,
    `echo "SM_PID=$!"`,
  ].join('\n');
  const pid = await readPid(client, command);
  if (!pid) throw new Error('nohup 启动失败：未能获取远程进程 PID');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const check = await runExec(
    client,
    `kill -0 ${pid} 2>/dev/null && echo ALIVE=1 || echo ALIVE=0`,
    { timeoutMs: 8000, maxBytes: 4096 },
  );
  const pgid = await readPgid(client, pid);
  if (!/ALIVE=1/.test(check.stdout)) {
    return { pid, pgid };
  }
  return { pid, pgid };
}

export async function launchJob(
  jobId: string,
  preference: JobLauncherPreference = 'auto',
): Promise<void> {
  const job = getJobRow(jobId);
  if (!job || job.status !== 'starting') return;
  const mode = rowSessionMode(job);
  const target = getTargetRow(job.target_id);
  const project = getProjectRow(job.project_id);
  if (!target || !project) {
    transitionJob(jobId, 'start_failed', { patch: { error: '项目或目标已被删除' } });
    return;
  }

  try {
    const cfg = getServerConnectConfig(job.server_id);
    await withClient(cfg, async (client) => {
      const home = await resolveHome(client, job);
      const paths = buildJobPaths(home, jobId);
      const script = buildJobScript({
        jobId,
        projectName: project.name,
        serverName: job.server_name ?? target.server_name ?? '远程服务器',
        commandOverride: job.rendered_command,
        target: {
          label: target.label,
          remoteCodeDir: target.remote_code_dir,
          dataDir: target.data_dir,
          condaEnv: target.conda_env,
          envVars: parseJson<Record<string, string>>(target.env_vars_json, {}),
          preCommand: target.pre_command,
          runCommand: target.run_command,
          gpuDevices: target.gpu_devices,
        },
        logPath: paths.logPath,
        exitPath: paths.exitPath,
        pidPath: paths.pidPath,
      });

      const tools = await detectTools(client);
      if (!tools.bash) throw new Error('远程服务器缺少 bash，无法运行任务');

      let launcher: JobLauncher;
      let sessionName = job.session_name;
      let windowId = job.window_id;
      let windowName = job.window_name;

      if (mode === 'new') {
        launcher = chooseJobLauncher(preference, {
          tmux: tools.tmux,
          screen: tools.screen,
        });
        sessionName = null;
        windowId = null;
        windowName = null;
      } else {
        if (!isSessionLauncher(job.launcher)) {
          throw new Error('已有会话任务缺少启动工具信息，请重新创建任务');
        }
        launcher = job.launcher;
        if (!tools[launcher]) {
          throw new Error(`服务器当前无法使用 ${launcher}，请刷新或检查远端安装`);
        }
        if (!sessionName) throw new Error('已有会话任务缺少会话名称，请重新创建任务');
        const sessionCheck = await runExec(client, sessionCheckCommand(launcher, sessionName), {
          timeoutMs: 10_000,
          maxBytes: 4096,
        });
        if (!/SESS=1/.test(sessionCheck.stdout)) {
          throw new Error(`${launcher} 会话「${sessionName}」已不存在，请刷新会话列表后重试`);
        }
        if (mode === 'existing_window') {
          await verifyExistingWindow(client, launcher, sessionName, windowId, windowName);
        }
      }

      const localDir = path.join(TMP_DIR, 'jobs');
      fs.mkdirSync(localDir, { recursive: true });
      const localScript = path.join(localDir, `${jobId}.sh`);
      fs.writeFileSync(localScript, script.scriptContent, 'utf8');
      try {
        const jobsDir = `${paths.home}/.server_manager/jobs`;
        const logsDir = `${paths.home}/.server_manager/logs`;
        const mkdir = await runExec(client, `mkdir -p ${shq(jobsDir)} ${shq(logsDir)}`, {
          timeoutMs: 10_000,
          maxBytes: 4096,
        });
        if (mkdir.code !== 0) {
          throw new Error(`创建远程目录失败：${mkdir.stderr.trim() || `退出码 ${mkdir.code}`}`);
        }
        const cleaned = await runExec(
          client,
          `rm -f ${shq(paths.pidPath)} ${shq(paths.exitPath)} ${shq(paths.gatePath)}`,
          { timeoutMs: 10_000, maxBytes: 4096 },
        );
        if (cleaned.code !== 0) {
          throw new Error(`清理旧的任务状态文件失败：${cleaned.stderr.trim() || `退出码 ${cleaned.code}`}`);
        }
        const sftp = await openSftp(client);
        try {
          await sftpUploadFile(sftp, localScript, paths.scriptPath, { mode: 0o755 });
        } finally {
          try {
            sftp.end();
          } catch {
            // 忽略关闭异常
          }
        }
      } finally {
        fs.rmSync(localScript, { force: true });
      }

      updateJob(jobId, {
        renderedCommand: script.renderedCommand,
        scriptContent: script.scriptContent,
        scriptPath: paths.scriptPath,
        logPath: paths.logPath,
        exitPath: paths.exitPath,
      });

      const fresh = getJobRow(jobId);
      if (!fresh || fresh.status !== 'starting') {
        // 启动过程中被取消：脚本已上传但尚未执行，什么都不用清理
        return;
      }

      const now = Date.now();
      let launchedPid: { pid: number; pgid: number | null } | null = null;
      let launchMessage = '';

      if (mode === 'new' && !isSessionLauncher(launcher)) {
        const launched = await launchNohup(client, paths.scriptPath);
        launchedPid = launched.pid ? { pid: launched.pid, pgid: launched.pgid } : null;
        const alive = await runExec(
          client,
          `kill -0 ${launched.pid ?? 0} 2>/dev/null && echo ALIVE=1 || echo ALIVE=0`,
          { timeoutMs: 8000, maxBytes: 4096 },
        );
        const exitExists = await runExec(
          client,
          `[ -f ${shq(paths.exitPath)} ] && echo EXIT=1 || echo EXIT=0`,
          { timeoutMs: 8000, maxBytes: 4096 },
        );
        if (!/ALIVE=1/.test(alive.stdout) && !/EXIT=1/.test(exitExists.stdout)) {
          throw new Error('进程启动后立即退出，且未写入退出码（请检查远程日志与命令）');
        }
        launchMessage = `已通过 nohup 启动${launched.pid ? `（PID ${launched.pid}${launched.pgid ? `，PGID ${launched.pgid}` : ''}）` : ''}`;
      } else if (mode === 'new') {
        if (!isSessionLauncher(launcher)) {
          throw new Error('任务启动方式与会话模式不一致');
        }
        sessionName = await launchDedicatedSession(client, launcher, jobId, paths.scriptPath);
        const found = await waitForJobPid(client, paths.pidPath, 10_000);
        if (!found) {
          try {
            await runExec(client, sessionCloseCommand(launcher, sessionName), {
              timeoutMs: 8000,
              maxBytes: 4096,
            });
          } catch {
            // 会话可能已不存在
          }
          throw new Error(`${launcher} 会话已创建，但任务脚本未写入 PID 文件；已清理新建会话`);
        }
        launchedPid = found;
        launchMessage = `已通过 ${launcher} 新建会话 ${sessionName} 启动（PID ${found.pid}${found.pgid ? `，PGID ${found.pgid}` : ''}）`;
      } else if (mode === 'new_window') {
        if (!sessionName) throw new Error('已有会话任务缺少会话名称，请重新创建任务');
        if (!isSessionLauncher(launcher)) {
          throw new Error('任务启动方式与会话模式不一致');
        }
        const title = windowName ?? jobWindowName(jobId);
        windowName = title;
        if (launcher === 'tmux') {
          const result = await runExec(
            client,
            sessionNewWindowCommand(launcher, sessionName, title, paths.scriptPath),
            { timeoutMs: 15_000, maxBytes: 64 * 1024 },
          );
          if (result.code !== 0) {
            throw new Error(
              `tmux 新建窗口失败：${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}`,
            );
          }
          windowId = /@\d+/g.exec(result.stdout)?.pop() ?? null;
          if (!windowId) windowId = await findTmuxWindowIdByTitle(client, sessionName, title);
          if (!windowId) throw new Error('tmux 新窗口创建后未获取到窗口标识，请刷新会话列表后重试');
        } else {
          const result = await runExec(
            client,
            sessionNewWindowCommand(launcher, sessionName, title, paths.scriptPath),
            { timeoutMs: 15_000, maxBytes: 64 * 1024 },
          );
          if (result.code !== 0) {
            throw new Error(
              `screen 新建窗口失败：${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}`,
            );
          }
          windowId = await findScreenWindowIndex(client, sessionName, title);
        }
        const found = await waitForJobPid(client, paths.pidPath, 8000);
        if (!found) {
          await closeLaunchedWindow(client, launcher, sessionName, windowId, windowName);
          throw new Error(`${launcher} 新窗口未启动任务脚本；已清理新建窗口，请检查日志与命令`);
        }
        launchedPid = found;
        if (launcher === 'screen' && !windowId) {
          windowId = await findScreenWindowIndex(client, sessionName, title);
        }
        launchMessage = `已在 ${launcher} 会话 ${sessionName} 新开窗口 ${windowId ?? title} 启动（PID ${found.pid}${found.pgid ? `，PGID ${found.pgid}` : ''}）`;
      } else {
        if (!sessionName || !windowId) {
          throw new Error('已有窗口任务缺少会话或窗口标识，请重新创建任务');
        }
        if (!isSessionLauncher(launcher)) {
          throw new Error('任务启动方式与会话模式不一致');
        }
        const gate = await runExec(
          client,
          `printf 'go\\n' > ${shq(paths.gatePath)}`,
          { timeoutMs: 8000, maxBytes: 4096 },
        );
        if (gate.code !== 0) {
          throw new Error(`创建启动闸门失败：${gate.stderr.trim() || `退出码 ${gate.code}`}`);
        }
        const sent = await runExec(
          client,
          sessionWindowRunCommand(launcher, sessionName, windowId, paths.scriptPath, paths.gatePath),
          { timeoutMs: 10_000, maxBytes: 64 * 1024 },
        );
        if (sent.code !== 0) {
          await runExec(client, `rm -f ${shq(paths.gatePath)}`, { timeoutMs: 8000, maxBytes: 4096 });
          throw new Error(
            `向 ${launcher} 窗口发送命令失败：${(sent.stderr || sent.stdout).trim() || `退出码 ${sent.code}`}`,
          );
        }
        let found = await waitForJobPid(client, paths.pidPath, 8000);
        await runExec(client, `rm -f ${shq(paths.gatePath)}`, {
          timeoutMs: 8000,
          maxBytes: 4096,
        });
        if (!found) found = await readJobPid(client, paths.pidPath);
        if (!found) {
          throw new Error(
            '目标窗口未在 8 秒内执行任务脚本（可能正忙）；已撤销排队命令，请选择空闲窗口或使用“新开窗口”',
          );
        }
        launchedPid = found;
        launchMessage = `已向 ${launcher} 会话 ${sessionName} 的窗口 ${windowId} 发送任务脚本（PID ${found.pid}${found.pgid ? `，PGID ${found.pgid}` : ''}）`;
      }

      updateJob(jobId, {
        launcher,
        sessionMode: mode,
        sessionName,
        windowId,
        windowName,
        remotePid: launchedPid?.pid ?? null,
        remotePgid: launchedPid?.pgid ?? null,
      });
      appendJobEvent(jobId, 'launch', launchMessage);

      transitionJob(jobId, 'running', {
        patch: { startedAt: now, lastSeenAt: now },
        message: `任务已启动（${launcher}）`,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`任务启动失败 ${jobId}`, { message });
    const fresh = getJobRow(jobId);
    if (fresh && fresh.status === 'starting') {
      transitionJob(jobId, 'start_failed', {
        patch: { error: message, finishedAt: Date.now() },
        message: `启动失败：${message}`,
      });
    }
  }
}