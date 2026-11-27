import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobDTO, JobInput, JobStatus, ListResponse } from '@sm/shared';
import { apiGet, apiPost } from './client';

export type JobFilter = {
  targetId?: string;
  projectId?: string;
  serverId?: string;
  active?: boolean;
  status?: JobStatus;
  limit?: number;
};

export const jobKeys = {
  all: ['jobs'] as const,
  list: (filter: JobFilter = {}) =>
    [
      ...jobKeys.all,
      'list',
      filter.targetId ?? null,
      filter.projectId ?? null,
      filter.serverId ?? null,
      filter.active ?? null,
      filter.status ?? null,
      filter.limit ?? null,
    ] as const,
  detail: (id: string) => [...jobKeys.all, 'detail', id] as const,
};

function buildQuery(filter: JobFilter): string {
  const params = new URLSearchParams();
  if (filter.targetId) params.set('targetId', filter.targetId);
  if (filter.projectId) params.set('projectId', filter.projectId);
  if (filter.serverId) params.set('serverId', filter.serverId);
  if (filter.active !== undefined) params.set('active', String(filter.active));
  if (filter.status) params.set('status', filter.status);
  if (filter.limit) params.set('limit', String(filter.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function useJobs(filter: JobFilter = {}, pollingMs: number | false = 4000) {
  return useQuery({
    queryKey: jobKeys.list(filter),
    queryFn: () =>
      apiGet<ListResponse<JobDTO>>(`/api/jobs${buildQuery(filter)}`).then((res) => res.items),
    refetchInterval: pollingMs,
  });
}

export function useJob(id: string | undefined, polling = false) {
  return useQuery({
    queryKey: jobKeys.detail(id ?? ''),
    queryFn: () => apiGet<JobDTO>(`/api/jobs/${id}`),
    enabled: Boolean(id),
    refetchInterval: polling ? 2500 : false,
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: JobInput) => apiPost<JobDTO>('/api/jobs', input),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKeys.detail(job.id), job);
      void queryClient.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}

export function useStopJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; force?: boolean }) =>
      apiPost<JobDTO>(`/api/jobs/${args.id}/stop`, { force: Boolean(args.force) }),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKeys.detail(job.id), job);
      void queryClient.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}