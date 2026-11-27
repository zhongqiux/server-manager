import { renderTemplate, shq, type TemplateVars } from '@sm/shared';

export type JobScriptTarget = {
  label: string | null;
  remoteCodeDir: string;
  dataDir: string | null;
  condaEnv: string | null;
  envVars: Record<string, string>;
  preCommand: string | null;
  runCommand: string;
  gpuDevices: string | null;
};

export type BuildJobScriptOptions = {
  jobId: string;
  projectName: string;
  serverName: string;
  target: JobScriptTarget;
  commandOverride?: string | null;
  logPath?: string | null;
  exitPath?: string | null;
  pidPath?: string | null;
  generatedAt?: Date;
};

export type JobScript = {
  renderedCommand: string;
  renderedPreCommand: string | null;
  scriptContent: string;
  warnings: string[];
};

export function buildTemplateVars(opts: BuildJobScriptOptions): TemplateVars {
  return {
    remote_dir: opts.target.remoteCodeDir,
    data_dir: opts.target.dataDir ?? '',
    project_name: opts.projectName,
    server_name: opts.serverName,
    gpu_devices: opts.target.gpuDevices ?? '',
    job_id: opts.jobId,
  };
}

export function buildJobScript(opts: BuildJobScriptOptions): JobScript {
  const { target } = opts;
  const vars = buildTemplateVars(opts);
  const commandTemplate = opts.commandOverride?.trim() ? opts.commandOverride.trim() : target.runCommand;
  const renderedCommand = renderTemplate(commandTemplate, vars).trim();
  const renderedPreCommand = target.preCommand?.trim()
    ? renderTemplate(target.preCommand, vars).trim()
    : null;
  const warnings: string[] = [];

  if (!target.dataDir && /\{\{\s*data_dir\s*\}\}/.test(`${commandTemplate}\n${target.preCommand ?? ''}`)) {
    warnings.push('模板引用了 {{data_dir}}，但该目标未配置数据目录，将渲染为空字符串。');
  }

  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# Server Manager 任务脚本');
  lines.push(
    `# job=${opts.jobId} project=${opts.projectName} server=${opts.serverName}${
      target.label ? ` target=${target.label}` : ''
    }`,
  );
  lines.push(`# generated ${(opts.generatedAt ?? new Date()).toISOString()} — 由调度台生成，重复运行会覆盖`);
  lines.push('set -o pipefail');
  lines.push(`cd ${shq(target.remoteCodeDir)} || { echo "[server-manager] 无法进入远程目录" >&2; exit 97; }`);
  lines.push(`export SM_JOB_ID=${shq(opts.jobId)}`);
  lines.push(`export SM_REMOTE_DIR=${shq(target.remoteCodeDir)}`);
  if (target.dataDir) lines.push(`export SM_DATA_DIR=${shq(target.dataDir)}`);
  if (target.gpuDevices) lines.push(`export CUDA_VISIBLE_DEVICES=${shq(target.gpuDevices)}`);

  if (opts.pidPath) {
    lines.push('');
    lines.push('# 记录脚本进程与进程组，供已有会话/窗口中的精确停止使用');
    lines.push(`mkdir -p ${shq(parentDir(opts.pidPath))}`);
    lines.push(
      `printf '%s %s\\n' "$$" "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" > ${shq(opts.pidPath)}`,
    );
  }

  const envKeys = Object.keys(target.envVars).sort();
  if (envKeys.length > 0) {
    lines.push('');
    lines.push('# 目标环境变量');
    for (const key of envKeys) {
      lines.push(`export ${key}=${shq(target.envVars[key] ?? '')}`);
    }
  }

  if (target.condaEnv) {
    lines.push('');
    lines.push('# conda 环境');
    lines.push('if command -v conda >/dev/null 2>&1; then');
    lines.push('  eval "$(conda shell.bash hook)"');
    lines.push(`  conda activate ${shq(target.condaEnv)} || { echo "[server-manager] conda 环境激活失败" >&2; exit 98; }`);
    lines.push('else');
    lines.push('  echo "[server-manager] 未找到 conda，无法激活环境" >&2');
    lines.push('  exit 98');
    lines.push('fi');
  }

  if (renderedPreCommand) {
    lines.push('');
    lines.push('# 前置命令');
    lines.push(renderedPreCommand);
  }

  lines.push('');
  lines.push('# ---- 运行命令 ----');
  if (opts.logPath) {
    lines.push(`mkdir -p ${shq(parentDir(opts.logPath))}`);
    // 子 shell 包裹：命令内部的 exit 只结束子 shell，仍能捕获退出码
    lines.push('(');
    lines.push(renderedCommand);
    lines.push(`) >> ${shq(opts.logPath)} 2>&1`);
    lines.push('SM_EXIT=$?');
    if (opts.exitPath) {
      lines.push(`mkdir -p ${shq(parentDir(opts.exitPath))}`);
      lines.push(`echo "$SM_EXIT" > ${shq(opts.exitPath)}`);
    }
    lines.push('exit "$SM_EXIT"');
  } else {
    lines.push(renderedCommand);
  }

  return {
    renderedCommand,
    renderedPreCommand,
    scriptContent: `${lines.join('\n')}\n`,
    warnings,
  };
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx > 0 ? filePath.slice(0, idx) : '/';
}