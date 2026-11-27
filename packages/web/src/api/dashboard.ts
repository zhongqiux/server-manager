import { useQuery } from '@tanstack/react-query';
import type { DashboardDTO } from '@sm/shared';
import { apiGet } from './client';

export const dashboardKeys = {
  all: ['dashboard'] as const,
};

export function useDashboard() {
  return useQuery({
    queryKey: dashboardKeys.all,
    queryFn: () => apiGet<DashboardDTO>('/api/dashboard'),
    refetchInterval: 15_000,
  });
}