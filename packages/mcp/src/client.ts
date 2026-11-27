import type {
  DashboardDTO,
  IgnoreExplainResult,
  JobDTO,
  JobInput,
  JobStatus,
  ProbeResult,
  ProjectDTO,
  ProjectScanResult,
  RemoteSessionList,
  ServerDTO,
  ServerTestResult,
  SyncRunDTO,
  TargetDTO,
  TargetPreview,
} from '@sm/shared';

const DISCOVERY_PORTS = Array.from({ length: 20 }, (_, index) => 8787 + index);

export type HealthInfo = {
  ok: boolean;
  version: string;
  node: string;
  uptime: number;
  demo: boolean;
};

export type JobLogChunk = {
  start: number;
  end: number;
  size: number | null;
  data: string;
};

export type StartSyncInput = {
  targetId: string;
  dryRun?: boolean;
  sourceTargetId?: string;
  confirmTargetName?: string;
};

export type SyncRunFilter = {
  targetId?: string;
  projectId?: string;
  limit?: number;
};

export type JobFilter = {
  targetId?: string;
  projectId?: string;
  serverId?: string;
  active?: boolean;
  status?: JobStatus;
  limit?: number;
};

export type TargetFilter = {
  projectId?: string;
  serverId?: string;
};

export class SmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmUnavailableError';
  }
}

export class SmApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, status: number, code: string | null, details?: unknown) {
    super(message);
    this.name = 'SmApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
};

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function discoverBase(
  ports: number[] = DISCOVERY_PORTS,
  timeoutMs = 500,
): Promise<string | null> {
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { ok?: unknown; version?: unknown };
        return data.ok === true && typeof data.version === 'string'
          ? `http://127.0.0.1:${port}`
          : null;
      } catch {
        return null;
      }
    }),
  );
  return results.find((item): item is string => item !== null) ?? null;
}

export class SmClient {
  private readonly configuredBase: string | null;
  private readonly defaultTimeoutMs: number;
  private baseUrl: string | null = null;

  constructor(options: { baseUrl?: string | null; timeoutMs?: number } = {}) {
    this.configuredBase = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : null;
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
  }

  get configuredBaseUrl(): string | null {
    return this.configuredBase;
  }

  private async resolveBase(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    if (this.configuredBase) {
      this.baseUrl = this.configuredBase;
      return this.baseUrl;
    }
    const found = await discoverBase();
    if (!found) {
      throw new SmUnavailableError(
        '无法连接 Server Manager（已尝试 127.0.0.1:8787–8806）。请先启动应用：npm start 或 ServerManager.exe。',
      );
    }
    this.baseUrl = found;
    return found;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    let rediscovered = false;

    for (;;) {
      const base = await this.resolveBase();
      let response: Response;
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (isTimeoutError(err)) {
          throw new Error(`请求超时（${timeoutMs} ms）：${method} ${path}`);
        }
        if (!this.configuredBase && !rediscovered) {
          rediscovered = true;
          this.baseUrl = null;
          continue;
        }
        throw new SmUnavailableError(
          `无法连接 Server Manager（${base}）。请确认应用正在运行。`,
        );
      }

      const text = await response.text();
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        let code: string | null = null;
        let details: unknown;
        try {
          const parsed = JSON.parse(text) as {
            error?: { code?: unknown; message?: unknown; details?: unknown };
          };
          if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
            message = parsed.error.message;
          }
          if (typeof parsed.error?.code === 'string') code = parsed.error.code;
          details = parsed.error?.details;
        } catch {
          // 非 JSON 错误体，保留 HTTP 状态
        }
        throw new SmApiError(message, response.status, code, details);
      }

      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SmApiError('接口返回的不是合法 JSON', response.status, 'BAD_RESPONSE');
      }
    }
  }

  health(timeoutMs = 3000): Promise<HealthInfo> {
    return this.request<HealthInfo>('/api/health', { timeoutMs });
  }

  getOverview(timeoutMs = 20_000): Promise<DashboardDTO> {
    return this.request<DashboardDTO>('/api/dashboard', { timeoutMs });
  }

  async listServers(): Promise<ServerDTO[]> {
    const data = await this.request<{ items: ServerDTO[] }>('/api/servers');
    return data.items;
  }

  getServer(id: string): Promise<ServerDTO> {
    return this.request<ServerDTO>(`/api/servers/${encodeURIComponent(id)}`);
  }

  testServer(id: string): Promise<ServerTestResult> {
    return this.request<ServerTestResult>(
      `/api/servers/${encodeURIComponent(id)}/test`,
      { method: 'POST', body: {}, timeoutMs: 120_000 },
    );
  }

  probeServer(id: string): Promise<ProbeResult> {
    return this.request<ProbeResult>(
      `/api/servers/${encodeURIComponent(id)}/probe`,
      { method: 'POST', body: {}, timeoutMs: 180_000 },
    );
  }

  listRemoteSessions(id: string): Promise<RemoteSessionList> {
    return this.request<RemoteSessionList>(
      `/api/servers/${encodeURIComponent(id)}/sessions`,
      { timeoutMs: 60_000 },
    );
  }

  async listProjects(): Promise<ProjectDTO[]> {
    const data = await this.request<{ items: ProjectDTO[] }>('/api/projects');
    return data.items;
  }

  getProject(id: string): Promise<ProjectDTO> {
    return this.request<ProjectDTO>(`/api/projects/${encodeURIComponent(id)}`);
  }

  scanProject(id: string): Promise<ProjectScanResult> {
    return this.request<ProjectScanResult>(
      `/api/projects/${encodeURIComponent(id)}/scan`,
      { method: 'POST', body: {}, timeoutMs: 120_000 },
    );
  }

  explainIgnore(id: string, path: string, targetId?: string): Promise<IgnoreExplainResult> {
    return this.request<IgnoreExplainResult>(
      `/api/projects/${encodeURIComponent(id)}/ignore/explain`,
      { method: 'POST', body: { path, targetId } },
    );
  }

  async listTargets(filter: TargetFilter = {}): Promise<TargetDTO[]> {
    const data = await this.request<{ items: TargetDTO[] }>(
      `/api/targets${query({ projectId: filter.projectId, serverId: filter.serverId })}`,
    );
    return data.items;
  }

  getTarget(id: string): Promise<TargetDTO> {
    return this.request<TargetDTO>(`/api/targets/${encodeURIComponent(id)}`);
  }

  previewTarget(id: string): Promise<TargetPreview> {
    return this.request<TargetPreview>(
      `/api/targets/${encodeURIComponent(id)}/preview`,
      { method: 'POST', body: {}, timeoutMs: 60_000 },
    );
  }

  startSync(input: StartSyncInput): Promise<SyncRunDTO> {
    return this.request<SyncRunDTO>('/api/sync/runs', {
      method: 'POST',
      body: {
        targetId: input.targetId,
        dryRun: input.dryRun ?? true,
        sourceTargetId: input.sourceTargetId,
        confirmTargetName: input.confirmTargetName,
      },
      timeoutMs: 30_000,
    });
  }

  async listSyncRuns(filter: SyncRunFilter = {}): Promise<SyncRunDTO[]> {
    const data = await this.request<{ items: SyncRunDTO[] }>(
      `/api/sync/runs${query({
        targetId: filter.targetId,
        projectId: filter.projectId,
        limit: filter.limit,
      })}`,
    );
    return data.items;
  }

  getSyncRun(id: string): Promise<SyncRunDTO> {
    return this.request<SyncRunDTO>(`/api/sync/runs/${encodeURIComponent(id)}`);
  }

  cancelSyncRun(id: string): Promise<SyncRunDTO> {
    return this.request<SyncRunDTO>(
      `/api/sync/runs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body: {}, timeoutMs: 30_000 },
    );
  }

  startJob(input: JobInput): Promise<JobDTO> {
    return this.request<JobDTO>('/api/jobs', {
      method: 'POST',
      body: input,
      timeoutMs: 30_000,
    });
  }

  async listJobs(filter: JobFilter = {}): Promise<JobDTO[]> {
    const data = await this.request<{ items: JobDTO[] }>(
      `/api/jobs${query({
        targetId: filter.targetId,
        projectId: filter.projectId,
        serverId: filter.serverId,
        active: filter.active,
        status: filter.status,
        limit: filter.limit,
      })}`,
    );
    return data.items;
  }

  getJob(id: string): Promise<JobDTO> {
    return this.request<JobDTO>(`/api/jobs/${encodeURIComponent(id)}`);
  }

  readJobLogs(
    id: string,
    options: { bytes?: number; end?: number } = {},
  ): Promise<JobLogChunk> {
    const bytes = Math.min(Math.max(options.bytes ?? 131_072, 1024), 262_144);
    const path =
      options.end === undefined
        ? `/api/jobs/${encodeURIComponent(id)}/logs/tail${query({ bytes })}`
        : `/api/jobs/${encodeURIComponent(id)}/logs/chunk${query({ bytes, end: options.end })}`;
    return this.request<JobLogChunk>(path, { timeoutMs: 60_000 });
  }

  stopJob(id: string, force = false): Promise<JobDTO> {
    return this.request<JobDTO>(`/api/jobs/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: { force },
      timeoutMs: 60_000,
    });
  }
}