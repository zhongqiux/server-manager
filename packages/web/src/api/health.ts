import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';

export type HealthResponse = {
  ok: boolean;
  version: string;
  node: string;
  uptime: number;
  demo: boolean;
};

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<HealthResponse>('/api/health'),
    staleTime: 60_000,
  });
}