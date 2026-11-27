import type { JobStatus } from './job-states.ts';
import type {
  GpuSnapshot,
  ServerStatus,
  SyncCounts,
  SyncMode,
  SyncPlan,
  SyncProgress,
  SyncRunStatus,
} from './types.ts';

export type SseEvent =
  | { type: 'ping'; ts: number }
  | { type: 'server.status'; serverId: string; status: ServerStatus; message?: string | null }
  | { type: 'gpu.snapshot'; snapshots: GpuSnapshot[] }
  | { type: 'job.status'; jobId: string; status: JobStatus; exitCode?: number | null }
  | {
      type: 'sync.summary';
      runId: string;
      targetId?: string | null;
      mode: SyncMode;
      status: SyncRunStatus;
      counts?: SyncCounts | null;
    };

export type JobLogStreamEvent =
  | { type: 'waiting'; jobId: string; message: string }
  | {
      type: 'snapshot';
      jobId: string;
      start: number;
      offset: number;
      size: number;
      data: string;
    }
  | { type: 'log'; jobId: string; offset: number; data: string }
  | { type: 'gapped'; jobId: string; from: number; to: number }
  | {
      type: 'reset';
      jobId: string;
      start: number;
      offset: number;
      size: number;
      data: string;
      reason: string;
    }
  | {
      type: 'end';
      jobId: string;
      reason: 'job_terminal' | 'no_log' | 'error' | 'closed';
      message?: string;
    };

export type SyncRunEvent =
  | { type: 'status'; runId: string; status: SyncRunStatus }
  | { type: 'plan'; runId: string; plan: SyncPlan }
  | ({ type: 'progress'; runId: string } & SyncProgress)
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string; ts: number }
  | { type: 'done'; runId: string; status: SyncRunStatus; counts: SyncCounts | null; error?: string | null }
  | { type: 'end' };