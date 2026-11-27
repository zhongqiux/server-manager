import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { inject } from 'postject';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const WEB_DIST = path.join(ROOT, 'packages', 'web', 'dist');
const BUNDLE = path.join(RELEASE, 'server-bundle.cjs');
const BLOB = path.join(RELEASE, 'server.blob');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const TAG = IS_WIN ? 'dist:win' : IS_MAC ? 'dist:mac' : 'dist';
const OUTPUT = path.join(RELEASE, IS_WIN ? 'ServerManager.exe' : 'ServerManager');
const SEA_CONFIG = path.join(RELEASE, 'sea-config.json');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(message) {
  console.error(`[${TAG}] ${message}`);
  process.exit(1);
}

function listFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

function findSigntool() {
  const candidates = [];
  const pf86 = process.env['ProgramFiles(x86)'];
  if (pf86) {
    const kits = path.join(pf86, 'Windows Kits', '10', 'bin');
    if (fs.existsSync(kits)) {
      for (const version of fs.readdirSync(kits)) {
        candidates.push(path.join(kits, version, 'x64', 'signtool.exe'));
      }
    }
  }
  try {
    const out = execFileSync('where', ['signtool.exe'], { encoding: 'utf8' });
    candidates.push(...out.split(/\r?\n/).filter(Boolean));
  } catch {
    // PATH 中没有 signtool
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function stripNodeSignature(file) {
  if (IS_WIN) {
    const signtool = findSigntool();
    if (!signtool) {
      console.warn(`[${TAG}] 未找到 signtool，注入可能因签名段校验失败`);
      return;
    }
    try {
      console.log(`[${TAG}] 移除 Node 官方签名（注入后 exe 为未签名）…`);
      execFileSync(signtool, ['remove', '/s', file], { stdio: 'ignore' });
    } catch {
      console.warn(`[${TAG}] 签名移除失败，继续尝试注入…`);
    }
    return;
  }

  try {
    console.log(`[${TAG}] 移除 Node 官方签名…`);
    execFileSync('codesign', ['--remove-signature', file], { stdio: 'ignore' });
  } catch {
    console.warn(`[${TAG}] 签名移除失败，继续尝试注入…`);
  }
}

function signMacBinary(file) {
  if (!IS_MAC) return;
  console.log(`[${TAG}] ad-hoc 签名…`);
  execFileSync('codesign', ['--sign', '-', '--force', file], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'inherit' });
}

function runSeaConfig() {
  try {
    execFileSync(process.execPath, ['--experimental-sea-config', path.relative(ROOT, SEA_CONFIG)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    return;
  } catch {
    const config = JSON.parse(fs.readFileSync(SEA_CONFIG, 'utf8'));
    if (!config.useCodeCache) throw new Error('SEA blob 生成失败');
    console.warn(`[${TAG}] 代码缓存不可用，退回禁用 useCodeCache 重试…`);
    config.useCodeCache = false;
    fs.writeFileSync(SEA_CONFIG, JSON.stringify(config, null, 2));
    execFileSync(process.execPath, ['--experimental-sea-config', path.relative(ROOT, SEA_CONFIG)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

async function main() {
  if (!IS_WIN && !IS_MAC) fail('仅支持在 Windows 或 macOS 上打包');
  console.log(`[${TAG}] 平台：${process.platform}/${process.arch}，Node ${process.version}`);

  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    fail('未找到前端构建产物，请先执行 npm run build');
  }

  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(RELEASE, { recursive: true });

  console.log(`[${TAG}] 打包服务端 bundle…`);
  await build({
    entryPoints: [path.join(ROOT, 'packages/server/src/main.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    external: ['*.node', 'cpu-features'],
    define: {
      'import.meta.url': JSON.stringify('file:///sea/server-bundle.cjs'),
    },
    logLevel: 'warning',
  });

  const webFiles = listFiles(WEB_DIST);
  if (!webFiles.includes('index.html')) fail('前端产物缺少 index.html');
  const manifestPath = path.join(RELEASE, 'web-asset-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(webFiles, null, 2));

  const assets = { 'web/asset-manifest.json': manifestPath };
  for (const rel of webFiles) {
    assets[`web/${rel}`] = path.join(WEB_DIST, rel);
  }

  const seaConfig = {
    main: path.relative(ROOT, BUNDLE).split(path.sep).join('/'),
    output: path.relative(ROOT, BLOB).split(path.sep).join('/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets,
  };
  fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2));

  console.log(`[${TAG}] 生成 SEA blob…`);
  runSeaConfig();

  console.log(`[${TAG}] 注入 Node 可执行文件…`);
  fs.copyFileSync(process.execPath, OUTPUT);
  if (!IS_WIN) fs.chmodSync(OUTPUT, 0o755);
  stripNodeSignature(OUTPUT);
  await inject(OUTPUT, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), {
    sentinelFuse: SEA_FUSE,
    ...(IS_MAC ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  signMacBinary(OUTPUT);

  const size = fs.statSync(OUTPUT).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(OUTPUT)).digest('hex');
  console.log(`[${TAG}] 完成：${OUTPUT}`);
  console.log(`[${TAG}] 体积：${(size / 1024 / 1024).toFixed(1)} MB（${size} 字节）`);
  console.log(`[${TAG}] SHA256：${sha256}`);
  console.log(`[${TAG}] Node：${process.version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});