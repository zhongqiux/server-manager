import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

let db: DatabaseSync | null = null;
const stmts = new Map<string, StatementSync>();

export function openDatabase(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = new DatabaseSync(file);
  instance.exec('PRAGMA journal_mode=WAL');
  instance.exec('PRAGMA synchronous=NORMAL');
  instance.exec('PRAGMA foreign_keys=ON');
  instance.exec('PRAGMA busy_timeout=5000');
  db = instance;
  stmts.clear();
  return instance;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

export function closeDatabase(): void {
  stmts.clear();
  db?.close();
  db = null;
}

export function prepare(sql: string): StatementSync {
  let stmt = stmts.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    stmts.set(sql, stmt);
  }
  return stmt;
}

export function transaction<T>(fn: () => T): T {
  const instance = getDb();
  instance.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    instance.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      instance.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误
    }
    throw err;
  }
}