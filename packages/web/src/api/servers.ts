import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ListResponse,
  ProbeResult,
  RemoteSessionList,
  ServerDTO,
  ServerInput,
  ServerTestResult,
} from '@sm/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export type ServerDraft = Partial<
  Pick<
    ServerInput,
    'host' | 'port' | 'username' | 'authType' | 'password' | 'privateKey' | 'passphrase' | 'hostKeyPolicy'
  >
>;

export const serverKeys = {
  all: ['servers'] as const,
  list: () => [...serverKeys.all, 'list'] as const,
  details: ['servers', 'detail'] as const,
  detail: (id: string) => [...serverKeys.details, id] as const,
  sessions: (id: string) => [...serverKeys.all, id, 'sessions'] as const,
};

export function useServers() {
  return useQuery({
    queryKey: serverKeys.list(),
    queryFn: () => apiGet<ListResponse<ServerDTO>>('/api/servers').then((res) => res.items),
  });
}

export function useServer(id: string | undefined) {
  return useQuery({
    queryKey: serverKeys.detail(id ?? ''),
    queryFn: () => apiGet<ServerDTO>(`/api/servers/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ServerInput) => apiPost<ServerDTO>('/api/servers', input),
    onSuccess: (server) => {
      queryClient.setQueryData(serverKeys.detail(server.id), server);
      void queryClient.invalidateQueries({ queryKey: serverKeys.all });
    },
  });
}

export function useUpdateServer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ServerInput>) => apiPatch<ServerDTO>(`/api/servers/${id}`, patch),
    onSuccess: (server) => {
      queryClient.setQueryData(serverKeys.detail(server.id), server);
      void queryClient.invalidateQueries({ queryKey: serverKeys.all });
    },
  });
}

export function useDeleteServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      apiDelete<{ ok: true }>(`/api/servers/${id}${force ? '?force=1' : ''}`),
    onSuccess: (_data, variables) => {
      queryClient.removeQueries({ queryKey: serverKeys.detail(variables.id) });
      void queryClient.invalidateQueries({ queryKey: serverKeys.all });
    },
  });
}

export function useTestDraft() {
  return useMutation({
    mutationFn: (input: ServerInput) => apiPost<ServerTestResult>('/api/servers/test', input),
  });
}

export function useTestServer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft?: ServerDraft) =>
      apiPost<ServerTestResult>(`/api/servers/${id}/test`, draft ? { useDraft: draft } : {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: serverKeys.list() });
    },
  });
}

export function useTestServerById() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<ServerTestResult>(`/api/servers/${id}/test`, {}),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: serverKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: serverKeys.list() });
    },
  });
}

export function useProbeServer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<ProbeResult>(`/api/servers/${id}/probe`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: serverKeys.list() });
    },
  });
}

export function useRemoteSessions(serverId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: serverKeys.sessions(serverId ?? ''),
    queryFn: () => apiGet<RemoteSessionList>(`/api/servers/${serverId}/sessions`),
    enabled: Boolean(serverId) && enabled,
    staleTime: 20_000,
    retry: 1,
  });
}