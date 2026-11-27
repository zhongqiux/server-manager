import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'site');
const out = path.join(src, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const entry of readdirSync(src)) {
  if (entry === 'dist' || entry.startsWith('.')) continue;
  cpSync(path.join(src, entry), path.join(out, entry), { recursive: true });
}

if (!existsSync(path.join(out, 'index.html'))) {
  throw new Error('site/dist/index.html 缺失');
}

console.log(`[site] 已生成 ${path.relative(root, out)}`);