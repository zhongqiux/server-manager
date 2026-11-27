import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshConnectConfig } from '../types.ts';

export type ConnectedSsh = {
  client: Client;
  fingerprint: string | null;
};

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export type SshErrorInfo = { code: string; message: string };

export function classifySshError(err: unknown): SshErrorInfo {
  const e = err as NodeJS.ErrnoException & { level?: string; message?: string };
  const raw = e?.message ?? String(err);
  if (e?.code === 'ECONNREFUSED') {
    return { code: 'OFFLINE', message: '连接被拒绝：SSH 端口未开放或服务未启动' };
  }
  if (e?.code === 'ETIMEDOUT' || e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') {
    return { code: 'OFFLINE', message: '网络不可达或连接超时' };
  }
  if (e?.code === 'ENOTFOUND') {
    return { code: 'OFFLINE', message: '主机名无法解析' };
  }
  if (/host.?key|verification failed|host denied/i.test(raw)) {
    return {
      code: 'HOST_KEY_CHANGED',
      message: '主机指纹校验失败：与记录不一致或未获信任，请确认服务器是否被更换',
    };
  }
  if (e?.level === 'client-authentication') {
    return { code: 'AUTH_FAILED', message: '认证失败：用户名、密码或私钥不正确' };
  }
  if (e?.level === 'client-timeout') {
    return { code: 'OFFLINE', message: 'SSH 握手超时，请检查网络或端口' };
  }
  if (/encrypted|passphrase/i.test(raw)) {
    return { code: 'AUTH_FAILED', message: '私钥已加密或口令不正确' };
  }
  return { code: 'SSH_ERROR', message: raw };
}

export function connectSsh(cfg: SshConnectConfig): Promise<ConnectedSsh> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint: string | null = null;
    let settled = false;

    const connectConfig: ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        fingerprint = fingerprintOf(key);
        if (
          cfg.hostKeyPolicy === 'strict' &&
          cfg.expectedFingerprint &&
          cfg.expectedFingerprint !== fingerprint
        ) {
          verify(false);
          return;
        }
        verify(true);
      },
    };

    if (cfg.authType === 'password') {
      connectConfig.password = cfg.password ?? '';
      connectConfig.tryKeyboard = true;
      client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
        finish([cfg.password ?? '']);
      });
    } else {
      connectConfig.privateKey = cfg.privateKey ?? '';
      if (cfg.passphrase) connectConfig.passphrase = cfg.passphrase;
    }

    const onReady = () => {
      if (settled) return;
      settled = true;
      client.removeListener('error', onError);
      resolve({ client, fingerprint });
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      client.removeListener('ready', onReady);
      client.end();
      reject(err);
    };

    client.once('ready', onReady);
    client.once('error', onError);
    try {
      client.connect(connectConfig);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  });
}