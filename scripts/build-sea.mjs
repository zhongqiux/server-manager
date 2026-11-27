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
const EXE = path.join(RELEASE, 'ServerManager.exe');
const SEA_CONFIG = path.join(RELEASE, 'sea-config.json');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(message) {
  console.error(`[dist:win] ${message}`);
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
    console.warn('[dist:win] 代码缓存不可用，退回禁用 useCodeCache 重试…');
    config.useCodeCache = false;
    fs.writeFileSync(SEA_CONFIG, JSON.stringify(config, null, 2));
    execFileSync(process.execPath, ['--experimental-sea-config', path.relative(ROOT, SEA_CONFIG)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

async function main() {
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    fail('未找到前端构建产物，请先执行 npm run build');
  }

  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(RELEASE, { recursive: true });

  console.log('[dist:win] 打包服务端 bundle…');
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

  console.log('[dist:win] 生成 SEA blob…');
  runSeaConfig();

  console.log('[dist:win] 注入 Node 可执行文件…');
  fs.copyFileSync(process.execPath, EXE);
  const signtool = findSigntool();
  if (signtool) {
    try {
      console.log('[dist:win] 移除 Node 官方签名（注入后 exe 为未签名）…');
      execFileSync(signtool, ['remove', '/s', EXE], { stdio: 'ignore' });
    } catch {
      console.warn('[dist:win] 签名移除失败，继续尝试注入…');
    }
  }
  await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), { sentinelFuse: SEA_FUSE });

  const size = fs.statSync(EXE).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
  console.log(`[dist:win] 完成：${EXE}`);
  console.log(`[dist:win] 体积：${(size / 1024 / 1024).toFixed(1)} MB（${size} 字节）`);
  console.log(`[dist:win] SHA256：${sha256}`);
  console.log(`[dist:win] Node：${process.version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});