import { canTransitionJob, isJobTerminal, type JobStatus } from '@sm/shared';
import { getJobRow, transitionJob, type JobRow } from '../services/jobs.ts';
import type { JobProbe } from './probe.ts';

export function applyExitResult(job: JobRow, probe: JobProbe): JobRow | null {
  if (!probe.exitFound) return null;
  const current = getJobRow(job.id);
  if (!current) return null;
  if (isJobTerminal(current.status as JobStatus)) return current;

  const status: JobStatus = probe.exitCode === 0 ? 'exited' : 'failed';
  if (!canTransitionJob(current.status as JobStatus, status)) return current;

  return transitionJob(job.id, status, {
    patch: {
      exitCode: probe.exitCode,
      finishedAt: Date.now(),
      logBytes: probe.logSize ?? current.log_bytes,
      error: status === 'failed' ? `退出码 ${probe.exitCode ?? '未知'}` : null,
    },
    message:
      probe.exitCode === null
        ? '任务结束（退出码未知）'
        : `任务结束，退出码 ${probe.exitCode}`,
    data: { exitCode: probe.exitCode },
  });
}