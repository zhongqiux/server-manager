import type { SFTPWrapper } from 'ssh2';
import type { SshConnectConfig } from '../transport/types.ts';
import { withClient } from '../transport/ssh/pool.ts';
import { openSftp, sftpStat } from '../transport/ssh/sftp.ts';

export async function readRangeSftp(
  sftp: SFTPWrapper,
  remotePath: string,
  start: number,
  endExclusive: number,
): Promise<Buffer> {
  if (endExclusive <= start) return Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(remotePath, { start, end: endExclusive - 1 });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (err: Error) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function statLogSize(
  cfg: SshConnectConfig,
  remotePath: string,
): Promise<number | null> {
  return withClient(cfg, async (client) => {
    const sftp = await openSftp(client);
    try {
      const stats = await sftpStat(sftp, remotePath);
      return stats ? stats.size : null;
    } finally {
      try {
        sftp.end();
      } catch {
        // 通道可能已被远端关闭
      }
    }
  });
}

export async function readLogRange(
  cfg: SshConnectConfig,
  remotePath: string,
  start: number,
  endExclusive: number,
): Promise<{ data: Buffer; size: number | null }> {
  return withClient(cfg, async (client) => {
    const sftp = await openSftp(client);
    try {
      const stats = await sftpStat(sftp, remotePath);
      if (!stats) return { data: Buffer.alloc(0), size: null };
      const boundedEnd = Math.min(endExclusive, stats.size);
      const data = await readRangeSftp(sftp, remotePath, start, boundedEnd);
      return { data, size: stats.size };
    } finally {
      try {
        sftp.end();
      } catch {
        // 忽略关闭异常
      }
    }
  });
}

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}