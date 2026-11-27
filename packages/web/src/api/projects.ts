import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IgnoreExplainResult,
  ListResponse,
  ProjectDTO,
  ProjectInput,
  ProjectScanResult,
} from '@sm/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  detail: (id: string) => [...projectKeys.all, 'detail', id] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: () => apiGet<ListResponse<ProjectDTO>>('/api/projects').then((res) => res.items),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id ?? ''),
    queryFn: () => apiGet<ProjectDTO>(`/api/projects/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectInput) => apiPost<ProjectDTO>('/api/projects', input),
    onSuccess: (project) => {
      queryClient.setQueryData(projectKeys.detail(project.id), project);
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useUpdateProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ProjectInput>) => apiPatch<ProjectDTO>(`/api/projects/${id}`, patch),
    onSuccess: (project) => {
      queryClient.setQueryData(projectKeys.detail(project.id), project);
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: true; deletedTargets: number }>(`/api/projects/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: projectKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['targets'] });
    },
  });
}

export function useScanProject(id: string) {
  return useMutation({
    mutationFn: () => apiPost<ProjectScanResult>(`/api/projects/${id}/scan`),
  });
}

export function useExplainIgnore(id: string) {
  return useMutation({
    mutationFn: (input: { path: string; targetId?: string }) =>
      apiPost<IgnoreExplainResult>(`/api/projects/${id}/ignore/explain`, input),
  });
}