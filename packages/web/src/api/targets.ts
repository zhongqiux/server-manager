import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitDetectResult, ListResponse, TargetDTO, TargetInput, TargetPreview } from '@sm/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export type TargetFilter = {
  projectId?: string;
  serverId?: string;
};

export const targetKeys = {
  all: ['targets'] as const,
  list: (filter: TargetFilter = {}) =>
    [...targetKeys.all, 'list', filter.projectId ?? null, filter.serverId ?? null] as const,
  detail: (id: string) => [...targetKeys.all, 'detail', id] as const,
  preview: (id: string) => [...targetKeys.all, 'preview', id] as const,
};

export function useTargets(filter: TargetFilter = {}) {
  return useQuery({
    queryKey: targetKeys.list(filter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.projectId) params.set('projectId', filter.projectId);
      if (filter.serverId) params.set('serverId', filter.serverId);
      const query = params.toString();
      return apiGet<ListResponse<TargetDTO>>(`/api/targets${query ? `?${query}` : ''}`).then(
        (res) => res.items,
      );
    },
  });
}

export function useTarget(id: string | undefined) {
  return useQuery({
    queryKey: targetKeys.detail(id ?? ''),
    queryFn: () => apiGet<TargetDTO>(`/api/targets/${id}`),
    enabled: Boolean(id),
  });
}

function invalidateTargets(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: targetKeys.all });
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
  void queryClient.invalidateQueries({ queryKey: ['servers'] });
}

export function useCreateTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TargetInput) => apiPost<TargetDTO>('/api/targets', input),
    onSuccess: (target) => {
      queryClient.setQueryData(targetKeys.detail(target.id), target);
      invalidateTargets(queryClient);
    },
  });
}

export function useUpdateTarget(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<TargetInput>) => apiPatch<TargetDTO>(`/api/targets/${id}`, patch),
    onSuccess: (target) => {
      queryClient.setQueryData(targetKeys.detail(target.id), target);
      void queryClient.removeQueries({ queryKey: targetKeys.preview(target.id) });
      invalidateTargets(queryClient);
    },
  });
}

export function useDeleteTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: true; deletedJobs: number }>(`/api/targets/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: targetKeys.detail(id) });
      invalidateTargets(queryClient);
    },
  });
}

export function usePreviewTargetDraft() {
  return useMutation({
    mutationFn: (input: TargetInput) => apiPost<TargetPreview>('/api/targets/preview', input),
  });
}

export function usePreviewSavedTarget() {
  return useMutation({
    mutationFn: (id: string) => apiPost<TargetPreview>(`/api/targets/${id}/preview`),
  });
}

export function useTargetPreview(id: string | undefined) {
  return useQuery({
    queryKey: targetKeys.preview(id ?? ''),
    queryFn: () => apiPost<TargetPreview>(`/api/targets/${id}/preview`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useDetectGitTarget() {
  return useMutation({
    mutationFn: (id: string) => apiPost<GitDetectResult>(`/api/targets/${id}/git/detect`),
  });
}