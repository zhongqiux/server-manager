export type McpConfig = {
  baseUrl: string | null;
  readOnly: boolean;
  timeoutMs: number;
};

function parseBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`SM_MCP_BASE_URL 不是合法 URL：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SM_MCP_BASE_URL 只支持 http/https');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('SM_MCP_BASE_URL 只接受服务地址，例如 http://127.0.0.1:8787');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const rawTimeout = Number(env.SM_MCP_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= 1000 ? Math.floor(rawTimeout) : 30_000;
  const readOnly = env.SM_MCP_READ_ONLY === '1' || env.SM_MCP_READ_ONLY === 'true';
  return {
    baseUrl: parseBaseUrl(env.SM_MCP_BASE_URL ?? env.SM_BASE_URL),
    readOnly,
    timeoutMs,
  };
}