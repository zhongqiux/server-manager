import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

let cached: Buffer | null = null;

export function loadMasterKey(file: string): Buffer {
  if (cached) return cached;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let key: Buffer;
  if (fs.existsSync(file)) {
    key = fs.readFileSync(file);
    if (key.length !== 32) {
      throw new Error(`主密钥文件损坏（期望 32 字节，实际 ${key.length}）：${file}`);
    }
  } else {
    key = randomBytes(32);
    fs.writeFileSync(file, key, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows 下 chmod 语义有限
    }
  }
  cached = key;
  return key;
}

export function resetMasterKeyCache(): void {
  cached = null;
}