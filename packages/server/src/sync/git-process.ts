import { spawn } from 'node:child_process';

export type GitRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string, source: 'stdout' | 'stderr') => void;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
};

export type GitResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  error: string | null;
};

export function runGit(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const lineBuf: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let total = 0;

    let child;
    try {
      child = spawn('git', args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          ...options.env,
        },
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const onLine = options.onLine;
    const emitLines = (source: 'stdout' | 'stderr', chunk: string): void => {
      if (!onLine) return;
      lineBuf[source] += chunk;
      let idx = lineBuf[source].indexOf('\n');
      while (idx >= 0) {
        onLine(lineBuf[source].slice(0, idx).replace(/\r$/, ''), source);
        lineBuf[source] = lineBuf[source].slice(idx + 1);
        idx = lineBuf[source].indexOf('\n');
      }
    };
    const flushLines = (): void => {
      if (!onLine) return;
      for (const source of ['stdout', 'stderr'] as const) {
        const rest = lineBuf[source].replace(/\r$/, '');
        if (rest) onLine(rest, source);
        lineBuf[source] = '';
      }
    };
    const capture = (source: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (total < maxBytes) {
        const text = chunk.toString('utf8');
        (source === 'stdout' ? stdout : stderr).push(text);
        total += chunk.length;
      }
      emitLines(source, chunk.toString('utf8'));
    };

    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));

    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // 进程可能已退出
      }
    };
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const finish = (code: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      flushLines();
      resolve({
        code,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        timedOut,
        aborted,
        error,
      });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, null));
  });
}