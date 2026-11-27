import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('db');

export function migrate(instance: DatabaseSync): void {
  const row = instance.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  let current = Number(row?.user_version ?? 0);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    instance.exec('BEGIN IMMEDIATE');
    try {
      instance.exec(migration.sql);
      instance.exec(`PRAGMA user_version = ${migration.version}`);
      instance.exec('COMMIT');
      current = migration.version;
      log.info(`已应用迁移 v${migration.version} ${migration.name}`);
    } catch (err) {
      try {
        instance.exec('ROLLBACK');
      } catch {
        // 保留原始错误
      }
      throw err;
    }
  }

  log.info(`数据库已就绪（user_version=${current}）`);
}