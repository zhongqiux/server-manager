import type { Client } from 'ssh2';
import type { ExecOptions, ExecResult } from '../types.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export type ExecStreamOptions = ExecOptions & {
  onLine?: (line: string, source: 'stdout' | 'stderr') => void;
};

export function runExecStream(
  client: Client,
  command: string,
  options: ExecStreamOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const onLine = options.onLine;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const lineBuf: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let totalBytes = 0;
    let truncated = false;

    const emitLines = (source: 'stdout' | 'stderr', chunk: string): void => {
      if (!onLine) return;
      lineBuf[source] += chunk;
      let idx = lineBuf[source].indexOf('\n');
      while (idx >= 0) {
        const line = lineBuf[source].slice(0, idx).replace(/\r$/, '');
        lineBuf[source] = lineBuf[source].slice(idx + 1);
        onLine(line, source);
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
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      flushLines();
      resolve(result);
    };

    client.exec(command, (err, stream) => {
      if (err) {
        settled = true;
        reject(err);
        return;
      }
      timer = setTimeout(() => {
        try {
          stream.close();
        } catch {
          // 忽略流已关闭
        }
        finish({
          code: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8') + `\n[执行超时 ${timeoutMs}ms]`,
        });
      }, timeoutMs);

      const collect = (target: Buffer[], chunk: Buffer, source: 'stdout' | 'stderr') => {
        if (truncated) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          truncated = true;
          try {
            stream.close();
          } catch {
            // 忽略
          }
          finish({
            code: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8') + '\n[输出超过上限，已截断]',
          });
          return;
        }
        target.push(chunk);
        emitLines(source, chunk.toString('utf8'));
      };

      stream.on('data', (chunk: Buffer) => collect(stdoutChunks, chunk, 'stdout'));
      stream.stderr.on('data', (chunk: Buffer) => collect(stderrChunks, chunk, 'stderr'));
      stream.on('close', (code: number | null) => {
        finish({
          code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
      stream.on('error', (streamErr: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(streamErr);
      });
    });
  });
}

export function runExec(client: Client, command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    client.exec(command, (err, stream) => {
      if (err) {
        settled = true;
        reject(err);
        return;
      }
      timer = setTimeout(() => {
        try {
          stream.close();
        } catch {
          // 忽略流已关闭
        }
        finish({
          code: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8') + `\n[执行超时 ${timeoutMs}ms]`,
        });
      }, timeoutMs);

      const collect = (target: Buffer[], chunk: Buffer) => {
        if (truncated) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          truncated = true;
          try {
            stream.close();
          } catch {
            // 忽略
          }
          finish({
            code: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8') + '\n[输出超过上限，已截断]',
          });
          return;
        }
        target.push(chunk);
      };

      stream.on('data', (chunk: Buffer) => collect(stdoutChunks, chunk));
      stream.stderr.on('data', (chunk: Buffer) => collect(stderrChunks, chunk));
      stream.on('close', (code: number | null) => {
        finish({
          code,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
      stream.on('error', (streamErr: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(streamErr);
      });
    });
  });
}