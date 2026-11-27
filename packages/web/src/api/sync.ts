import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListResponse, SyncRunDTO, SyncRunEvent } from '@sm/shared';
import { apiGet, apiPost } from './client';

export type SyncRunFilter = {
  targetId?: string;
  projectId?: string;
  limit?: number;
};

export const syncKeys = {
  all: ['sync'] as const,
  list: (filter: SyncRunFilter = {}) =>
    [...syncKeys.all, 'list', filter.targetId ?? null, filter.projectId ?? null, filter.limit ?? null] as const,
  detail: (id: string) => [...syncKeys.all, 'detail', id] as const,
};

export function useSyncRuns(filter: SyncRunFilter = {}, enabled = true) {
  return useQuery({
    queryKey: syncKeys.list(filter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.targetId) params.set('targetId', filter.targetId);
      if (filter.projectId) params.set('projectId', filter.projectId);
      if (filter.limit) params.set('limit', String(filter.limit));
      const query = params.toString();
      return apiGet<ListResponse<SyncRunDTO>>(`/api/sync/runs${query ? `?${query}` : ''}`).then(
        (res) => res.items,
      );
    },
    enabled,
  });
}

export function useSyncRun(id: string | undefined, polling = false) {
  return useQuery({
    queryKey: syncKeys.detail(id ?? ''),
    queryFn: () => apiGet<SyncRunDTO>(`/api/sync/runs/${id}`),
    enabled: Boolean(id),
    refetchInterval: polling ? 2000 : false,
  });
}

export type StartSyncInput = {
  targetId: string;
  dryRun?: boolean;
  sourceTargetId?: string;
  confirmTargetName?: string;
};

export function useStartSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartSyncInput) => apiPost<SyncRunDTO>('/api/sync/runs', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: syncKeys.all });
    },
  });
}

export function useCancelSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => apiPost<SyncRunDTO>(`/api/sync/runs/${runId}/cancel`),
    onSuccess: (run) => {
      queryClient.setQueryData(syncKeys.detail(run.id), run);
    },
  });
}

export function useSyncRunEvents(
  runId: string | null,
  onEvent: (event: SyncRunEvent) => void,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/sync/runs/${runId}/events`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as SyncRunEvent;
        handlerRef.current(event);
        if (event.type === 'end' || event.type === 'done') {
          source.close();
        }
      } catch {
        // 忽略无法解析的事件
      }
    };
    return () => source.close();
  }, [runId]);
}