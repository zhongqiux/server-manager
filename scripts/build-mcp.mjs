import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const STAGE = path.join(RELEASE, 'mcp');
const OUTPUT = path.join(RELEASE, 'ServerManager-mcp.zip');
const ENTRY = path.join(ROOT, 'packages/mcp/dist/index.js');
const IS_WIN = process.platform === 'win32';

function fail(message) {
  console.error(`[mcp] ${message}`);
  process.exit(1);
}

function smokeTest(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`initialize 超时；stderr：${stderr.slice(0, 400)}`));
    }, 12000);

    const finish = (ok, detail) => {
      clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error(detail));
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('"server-manager"')) {
        child.kill();
        finish(true);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (stdout.includes('"server-manager"')) finish(true);
      else finish(false, `initialize 失败（exit ${code}）；stderr：${stderr.slice(0, 400)}`);
    });
    child.on('error', (err) => finish(false, `无法启动 node：${err.message}`));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0' },
        },
      })}\n`,
    );
  });
}

async function main() {
  if (!fs.existsSync(ENTRY)) fail('未找到 packages/mcp/dist/index.js，请先执行 npm run build -w @sm/mcp');

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  console.log('[mcp] 打包 stdio 服务…');
  await build({
    entryPoints: [ENTRY],
    outfile: path.join(STAGE, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  fs.copyFileSync(path.join(ROOT, 'scripts/mcp-readme.txt'), path.join(STAGE, 'README.txt'));
  fs.copyFileSync(path.join(ROOT, 'scripts/mcp-config.example.json'), path.join(STAGE, 'mcp-config.example.json'));

  console.log('[mcp] 冒烟测试 initialize 握手…');
  await smokeTest(path.join(STAGE, 'index.js'));

  fs.rmSync(OUTPUT, { force: true });
  if (IS_WIN) {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path "${STAGE}\\*" -DestinationPath "${OUTPUT}"`],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('zip', ['-q', '-r', OUTPUT, '.'], { cwd: STAGE, stdio: 'inherit' });
  }
  fs.rmSync(STAGE, { recursive: true, force: true });

  const size = fs.statSync(OUTPUT).size;
  console.log(`[mcp] 完成：${OUTPUT}`);
  console.log(`[mcp] 体积：${(size / 1024).toFixed(0)} KB（${size} 字节）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});