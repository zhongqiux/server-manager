type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\/\/)([^/@\s:]+):([^/@\s]+)@/g, '$1***:***@'],
  [/(password|passphrase|token|secret)(["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1$2***'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  try {
    return ` ${redact(JSON.stringify(meta))}`;
  } catch {
    return '';
  }
}

export type Logger = {
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
};

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, meta?: unknown): void => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message)}${formatMeta(meta)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}