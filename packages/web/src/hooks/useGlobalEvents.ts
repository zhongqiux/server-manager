import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DashboardDTO, GpuSnapshot, ServerDTO, SseEvent } from '@sm/shared';
import { dashboardKeys } from '../api/dashboard';
import { serverKeys } from '../api/servers';
import { jobKeys } from '../api/jobs';
import { syncKeys } from '../api/sync';

function mergeGpu(server: ServerDTO, snapshots: Map<string, GpuSnapshot>): ServerDTO {
  const gpu = snapshots.get(server.id);
  return gpu ? { ...server, gpu } : server;
}

export function useGlobalEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;

    const apply = (event: SseEvent): void => {
      switch (event.type) {
        case 'gpu.snapshot': {
          const snapshots = new Map(event.snapshots.map((snapshot) => [snapshot.serverId, snapshot]));
          queryClient.setQueryData<DashboardDTO>(dashboardKeys.all, (prev) => {
            if (!prev) return prev;
            const servers = prev.servers.map((server) => mergeGpu(server, snapshots));
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
            return { ...prev, servers, stats: { ...prev.stats, gpuTotal, gpuIdle } };
          });
          queryClient.setQueryData<ServerDTO[]>(serverKeys.list(), (prev) =>
            prev ? prev.map((server) => mergeGpu(server, snapshots)) : prev,
          );
          queryClient.setQueriesData<ServerDTO>({ queryKey: serverKeys.details }, (prev) =>
            prev ? mergeGpu(prev, snapshots) : prev,
          );
          break;
        }
        case 'job.status':
          void queryClient.invalidateQueries({ queryKey: jobKeys.all });
          void queryClient.invalidateQueries({ queryKey: serverKeys.all });
          void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
          break;
        case 'server.status':
          void queryClient.invalidateQueries({ queryKey: serverKeys.all });
          void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
          break;
        case 'sync.summary':
          void queryClient.invalidateQueries({ queryKey: syncKeys.all });
          void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
          void queryClient.invalidateQueries({ queryKey: ['targets'] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          break;
        default:
          break;
      }
    };

    const connect = (): void => {
      if (source || disposed) return;
      const es = new EventSource('/api/events');
      es.onmessage = (message) => {
        try {
          apply(JSON.parse(message.data) as SseEvent);
        } catch {
          // 忽略无法解析的事件
        }
      };
      source = es;
    };

    const disconnect = (): void => {
      source?.close();
      source = null;
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        disconnect();
      } else {
        void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
        connect();
      }
    };

    if (!document.hidden) connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
    };
  }, [queryClient]);
}