/**
 * db/index.js — SQLite 数据访问层
 *
 * - 单例连接（WAL 模式），业务层不直接写 SQL，统一经 repository 方法
 * - schema 迁移：settings.schema_version + 启动时顺序迁移（MVP 仅 v1）
 * - 表结构见 系统架构设计_Architecture.md 4.2
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  // v1：初始表结构（10 张表）
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    fail_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('username','image')),
    source TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_at TEXT,
    last_run_status TEXT
  );

  CREATE TABLE IF NOT EXISTS task_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    tag TEXT,
    latest_tag TEXT,
    description TEXT,
    storage_size INTEGER,
    last_updated TEXT,
    display_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_task_images_task ON task_images(task_id);

  CREATE TABLE IF NOT EXISTS execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual','cleanup')),
    status TEXT NOT NULL CHECK (status IN ('success','partial','failed','skipped')),
    space_check TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    total_images INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    cleanup_result TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_execution_logs_task ON execution_logs(task_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS execution_log_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER NOT NULL REFERENCES execution_logs(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    tag TEXT,
    action TEXT NOT NULL CHECK (action IN ('pull','rmi')),
    status TEXT NOT NULL CHECK (status IN ('success','failed')),
    message TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_execution_log_items_log ON execution_log_items(log_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('task','system')),
    title TEXT NOT NULL,
    content TEXT,
    task_id INTEGER,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);

  CREATE TABLE IF NOT EXISTS credentials (
    channel TEXT PRIMARY KEY CHECK (channel IN ('telegram','smtp')),
    payload TEXT,
    key_version INTEGER NOT NULL DEFAULT 1,
    plain_fields TEXT,
    updated_at TEXT NOT NULL
  );
  `,
];

let _db = null;

/** 打开（或复用）数据库连接；返回单例 */
export function openDb() {
  if (_db) return _db;
  const dir = path.dirname(config.dbPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  migrate(_db);
  return _db;
}

/** 迁移：按 schema_version 顺序执行未应用的迁移 */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).get();
  const current = row ? Number.parseInt(row.value, 10) : 0;
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const tx = db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(v + 1));
    });
    tx();
  }
}

/** 关闭连接（测试用） */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** 仅供测试：重新打开指定路径（先 close） */
export function reopenDb(pathOverride) {
  closeDb();
  const prev = config.dbPath;
  config.dbPath = pathOverride;
  try {
    return openDb();
  } finally {
    config.dbPath = prev;
  }
}

export default function db() {
  return openDb();
}
