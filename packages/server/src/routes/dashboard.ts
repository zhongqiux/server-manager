import { Router } from 'express';
import type { DashboardDTO, DashboardStats, ServerDTO } from '@sm/shared';
import { prepare } from '../db/index.ts';
import { gpuHub } from '../realtime/gpuhub.ts';
import { listJobs } from '../services/jobs.ts';
import { listServers } from '../services/servers.ts';
import { listSyncRuns } from '../services/sync.ts';

export const dashboardRouter = Router();

function count(sql: string, params: (string | number)[] = []): number {
  return Number((prepare(sql).get(...params) as { c: number }).c);
}

function withGpu(server: ServerDTO): ServerDTO {
  return { ...server, gpu: gpuHub.getSnapshot(server.id) ?? undefined };
}

dashboardRouter.get('/', (_req, res) => {
  const servers = listServers().map(withGpu);

  let gpuTotal = 0;
  let gpuIdle = 0;
  for (const server of servers) {
    if (server.gpu?.supported) {
      gpuTotal += server.gpu.gpus.length;
      gpuIdle += server.gpu.idleCount;
    } else if (server.hardware?.gpuList) {
      gpuTotal += server.hardware.gpuList.length;
    }
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const stats: DashboardStats = {
    serversTotal: servers.length,
    serversOnline: servers.filter((server) => server.status === 'online').length,
    gpuTotal,
    gpuIdle,
    runningJobs: count(`SELECT COUNT(*) AS c FROM jobs WHERE status IN ('pending', 'syncing', 'starting', 'running')`),
    syncsToday: count('SELECT COUNT(*) AS c FROM sync_runs WHERE dry_run = 0 AND started_at >= ?', [
      todayStart.getTime(),
    ]),
  };

  const payload: DashboardDTO = {
    stats,
    servers,
    runningJobs: listJobs({ active: true, limit: 20 }),
    recentSyncs: listSyncRuns({ limit: 6 }),
  };
  res.json(payload);
});