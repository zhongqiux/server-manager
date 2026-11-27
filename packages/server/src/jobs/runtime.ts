import { logHub } from './loghub.ts';
import { recoverInterruptedJobs, startJobPoller, stopJobPoller } from './poller.ts';

let started = false;

export function startJobsRuntime(): void {
  if (started) return;
  started = true;
  recoverInterruptedJobs();
  startJobPoller();
}

export function stopJobsRuntime(): void {
  if (!started) return;
  started = false;
  stopJobPoller();
  logHub.shutdown();
}