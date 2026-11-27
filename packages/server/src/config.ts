import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

export const APP_VERSION = '0.1.0';
export const HOST = '127.0.0.1';
export const IS_SEA = isSea();

const moduleDir = IS_SEA
  ? path.dirname(process.execPath)
  : path.dirname(fileURLToPath(import.meta.url));
export const SM_ROOT = path.resolve(moduleDir, '../../..');

const argv = process.argv.slice(1);
const portArgIndex = argv.indexOf('--port');
const portArg = portArgIndex >= 0 ? Number(argv[portArgIndex + 1]) : Number.NaN;

export const CLI = {
  portable: argv.includes('--portable'),
  open: argv.includes('--open'),
  port: Number.isFinite(portArg) ? portArg : null,
};

function packagedDataDir(): string {
  if (CLI.portable) return path.join(path.dirname(process.execPath), 'data');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ServerManager', 'data');
  }
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'ServerManager', 'data');
}

export const DATA_DIR = process.env.SM_DATA_DIR
  ? path.resolve(process.env.SM_DATA_DIR)
  : IS_SEA
    ? packagedDataDir()
    : path.join(SM_ROOT, 'data');

export const DB_PATH = path.join(DATA_DIR, 'server_manager.db');
export const KEYS_DIR = path.join(DATA_DIR, 'keys');
export const MASTER_KEY_FILE = process.env.SM_MASTER_KEY_FILE
  ? path.resolve(process.env.SM_MASTER_KEY_FILE)
  : path.join(KEYS_DIR, 'master.key');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const RELAY_DIR = path.join(TMP_DIR, 'relay');
export const WEB_DIST_DIR = path.join(SM_ROOT, 'packages', 'web', 'dist');

export const PORT = Number(process.env.SM_PORT ?? CLI.port ?? 8787) || 8787;
const openEnv = process.env.SM_OPEN;
export const OPEN_BROWSER = CLI.open || openEnv === '1' || (IS_SEA && openEnv !== '0');
export const DEMO_MODE = process.env.SM_DEMO === '1';

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const SSH_MAX_CONCURRENCY = envInt('SM_SSH_MAX_CONCURRENCY', 4);
export const SFTP_FILE_CONCURRENCY = envInt('SM_SFTP_FILE_CONCURRENCY', 4);
export const GPU_INTERVAL_MS = envInt('SM_GPU_INTERVAL_MS', 5000);
export const LOG_TAIL_BYTES = envInt('SM_LOG_TAIL_BYTES', 131072);
export const RELAY_MAX_BYTES = envInt('SM_RELAY_MAX_BYTES', 2 * 1024 * 1024 * 1024);

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, KEYS_DIR, TMP_DIR, RELAY_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.chmodSync(KEYS_DIR, 0o700);
  } catch {
    // Windows 下 chmod 语义有限，忽略
  }
}