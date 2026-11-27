import type { JobRow } from '../services/jobs.ts';
import { execOnJobServer } from './probe.ts';
import {
  isSessionLauncher,
  normalizeSessionMode,
  screenWindowCloseByTitleCommand,
  screenWindowInterruptByTitleCommand,
  sessionCloseCommand,
  sessionInterruptCommand,
  sessionWindowCloseCommand,
  sessionWindowInterruptCommand,
} from './session.ts';

export function isDedicatedSessionJob(job: JobRow): boolean {
  return normalizeSessionMode(job.session_mode) === 'new';
}

export function usesExistingWindow(job: JobRow): boolean {
  return normalizeSessionMode(job.session_mode) === 'existing_window';
}

export function usesOwnedWindow(job: JobRow): boolean {
  return normalizeSessionMode(job.session_mode) === 'new_window';
}

export async function interruptJobTarget(job: JobRow): Promise<void> {
  if (!isSessionLauncher(job.launcher) || !job.session_name) return;
  const mode = normalizeSessionMode(job.session_mode);
  if (mode === 'new') {
    await execOnJobServer(job, sessionInterruptCommand(job.launcher, job.session_name), 8000);
    return;
  }
  if (
    job.launcher === 'screen' &&
    mode === 'new_window' &&
    job.window_name
  ) {
    await execOnJobServer(
      job,
      screenWindowInterruptByTitleCommand(job.session_name, job.window_name),
      8000,
    );
    return;
  }
  if (job.window_id) {
    await execOnJobServer(
      job,
      sessionWindowInterruptCommand(job.launcher, job.session_name, job.window_id),
      8000,
    );
    return;
  }
  if (job.launcher === 'screen' && job.window_name) {
    await execOnJobServer(
      job,
      screenWindowInterruptByTitleCommand(job.session_name, job.window_name),
      8000,
    );
  }
}

export async function closeOwnedWindow(job: JobRow): Promise<void> {
  if (!isSessionLauncher(job.launcher) || !job.session_name) return;
  if (normalizeSessionMode(job.session_mode) !== 'new_window') return;
  if (job.launcher === 'screen' && job.window_name) {
    await execOnJobServer(job, screenWindowCloseByTitleCommand(job.session_name, job.window_name), 8000);
    return;
  }
  if (job.window_id) {
    await execOnJobServer(
      job,
      sessionWindowCloseCommand(job.launcher, job.session_name, job.window_id),
      8000,
    );
  }
}

export async function closeDedicatedSession(job: JobRow): Promise<void> {
  if (!isSessionLauncher(job.launcher) || !job.session_name) return;
  if (normalizeSessionMode(job.session_mode) !== 'new') return;
  await execOnJobServer(job, sessionCloseCommand(job.launcher, job.session_name), 8000);
}

export async function cleanupOwnedTarget(job: JobRow): Promise<void> {
  if (normalizeSessionMode(job.session_mode) === 'new') {
    await closeDedicatedSession(job);
    return;
  }
  if (normalizeSessionMode(job.session_mode) === 'new_window') {
    await closeOwnedWindow(job);
  }
  // existing_window 属于用户已有窗口，任何情况下都不关闭
}