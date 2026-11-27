import { shq } from '@sm/shared';
import { getServerConnectConfig } from '../services/servers.ts';
import type { JobRow } from '../services/jobs.ts';
import { execRemote } from '../transport/ssh/pool.ts';
import { isSessionLauncher, sessionCheckCommand } from './session.ts';

export type JobProbe = {
  session: boolean | null;
  alive: boolean | null;
  logSize: number | null;
  exitFound: boolean;
  exitCode: number | null;
};

export function buildProbeCommand(job: JobRow): string {
  const lines = ['set +e'];
  if (isSessionLauncher(job.launcher) && job.session_name) {
    lines.push(sessionCheckCommand(job.launcher, job.session_name));
  }
  if (job.remote_pid) {
    lines.push(
      `if kill -0 ${Number(job.remote_pid)} 2>/dev/null; then echo ALIVE=1; else echo ALIVE=0; fi`,
    );
  }
  if (job.log_path) {
    lines.push(
      `if [ -f ${shq(job.log_path)} ]; then printf 'SIZE=%s\\n' "$(wc -c < ${shq(job.log_path)} 2>/dev/null)"; else echo SIZE=-1; fi`,
    );
  }
  if (job.exit_path) {
    lines.push(
      `if [ -f ${shq(job.exit_path)} ]; then echo EXIT_FOUND=1; printf 'EXIT_CODE=%s\\n' "$(tr -dc '0-9' < ${shq(job.exit_path)} | head -c 8)"; else echo EXIT_FOUND=0; fi`,
    );
  }
  lines.push('echo PROBE_DONE=1');
  return lines.join('\n');
}

export function parseProbeOutput(stdout: string): JobProbe {
  const values = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(rawLine.trim());
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  const sizeText = values.get('SIZE');
  const size = sizeText === undefined ? null : Number(sizeText);
  const codeText = values.get('EXIT_CODE');
  return {
    session: values.has('SESS') ? values.get('SESS') === '1' : null,
    alive: values.has('ALIVE') ? values.get('ALIVE') === '1' : null,
    logSize: size === null || !Number.isFinite(size) || size < 0 ? null : size,
    exitFound: values.get('EXIT_FOUND') === '1',
    exitCode:
      values.get('EXIT_FOUND') === '1' && codeText !== undefined && /^\d+$/.test(codeText)
        ? Number(codeText)
        : null,
  };
}

export async function probeJob(job: JobRow): Promise<JobProbe> {
  const cfg = getServerConnectConfig(job.server_id);
  const result = await execRemote(cfg, buildProbeCommand(job), { timeoutMs: 12_000, maxBytes: 64 * 1024 });
  return parseProbeOutput(result.stdout);
}

export async function execOnJobServer(
  job: JobRow,
  command: string,
  timeoutMs = 20_000,
  maxBytes = 256 * 1024,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cfg = getServerConnectConfig(job.server_id);
  return execRemote(cfg, command, { timeoutMs, maxBytes });
}