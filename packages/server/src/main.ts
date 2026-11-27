import './warnings.ts';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
import {
  DATA_DIR,
  DB_PATH,
  DEMO_MODE,
  HOST,
  IS_SEA,
  OPEN_BROWSER,
  PORT,
  ensureDirs,
} from './config.ts';
import { closeDatabase, getDb, openDatabase } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { seedDemoData } from './demo/seed.ts';
import { startJobsRuntime, stopJobsRuntime } from './jobs/runtime.ts';
import { createLogger } from './logger.ts';
import { startGpuHub, stopGpuHub } from './realtime/gpuhub.ts';
import { shutdownPool } from './transport/ssh/pool.ts';

const log = createLogger('main');

function openBrowser(url: string): void {
  try {
    const options = { detached: true, stdio: 'ignore' as const, windowsHide: true };
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], options).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], options).unref();
    } else {
      spawn('xdg-open', [url], options).unref();
    }
  } catch (err) {
    log.warn('自动打开浏览器失败', { message: err instanceof Error ? err.message : String(err) });
  }
}

async function hasRunningInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string';
  } catch {
    return false;
  }
}

async function listenWithFallback(
  app: ReturnType<typeof createApp>,
  startPort: number,
): Promise<{ port: number; server: Server }> {
  for (let port = startPort; port < startPort + 20; port += 1) {
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const candidate = app.listen(port, HOST);
        candidate.once('listening', () => resolve(candidate));
        candidate.once('error', reject);
      });
      return { port, server };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw err;
      log.warn(`端口 ${port} 被占用，尝试下一个端口`);
    }
  }
  throw new Error('连续 20 个端口均被占用，无法启动');
}

async function main(): Promise<void> {
  ensureDirs();
  openDatabase(DB_PATH);
  migrate(getDb());
  if (DEMO_MODE) seedDemoData();

  const existingUrl = `http://${HOST}:${PORT}/`;
  if (await hasRunningInstance(PORT)) {
    log.info(`检测到已在运行的实例：${existingUrl}`);
    if (OPEN_BROWSER) openBrowser(existingUrl);
    closeDatabase();
    return;
  }

  const app = createApp();
  const { port, server } = await listenWithFallback(app, PORT);
  const url = `http://${HOST}:${port}/`;
  log.info(`服务已启动：${url}${IS_SEA ? '（单文件模式）' : ''}`);
  log.info(`数据目录：${DATA_DIR}`);
  if (OPEN_BROWSER) openBrowser(url);

  startJobsRuntime();
  startGpuHub();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在退出`);
    stopJobsRuntime();
    stopGpuHub();
    server.closeAllConnections();
    server.close(() => {
      shutdownPool();
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('启动失败', {
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exit(1);
});