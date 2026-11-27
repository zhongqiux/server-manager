export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type ExecOptions = {
  timeoutMs?: number;
  maxBytes?: number;
};

export type SshAuthType = 'password' | 'key';
export type HostKeyPolicy = 'tofu' | 'strict';

export type SshConnectConfig = {
  serverId: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  hostKeyPolicy?: HostKeyPolicy;
  expectedFingerprint?: string | null;
};