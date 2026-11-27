import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const binary = path.resolve(
  process.platform === 'win32' ? 'release/ServerManager.exe' : 'release/ServerManager',
);
const port = 18000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'sm-smoke-'));
const child = spawn(binary, ['--port', String(port)], {
  env: { ...process.env, SM_DATA_DIR: dataDir, SM_DEMO: '1', SM_OPEN: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let exited = false;
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
child.on('exit', () => {
  exited = true;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      // 服务尚未就绪
    }
    await sleep(500);
  }
  return false;
}

let ok = false;
try {
  ok = await waitForHealth();
  if (ok) {
    const res = await fetch(`http://127.0.0.1:${port}/api/servers`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    const servers = Array.isArray(body) ? body : body?.items;
    ok = Array.isArray(servers) && servers.some((server) => server.host === '192.0.2.10');
  }
} finally {
  if (!exited) {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(5000)]);
    if (!exited) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
}

if (!ok) {
  console.error(output);
  console.error(`[smoke] ${binary} 启动失败或演示数据不完整`);
  process.exit(1);
}
console.log(`[smoke] 通过：${binary} 在端口 ${port} 正常响应`);