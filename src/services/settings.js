/**
 * settings.js — settings 键值管理（模块 E）
 *
 * 键位（默认值）：
 * - setup_completed(0/1)、login_protection_enabled(1)、prune_enabled(0)、restart_cron(NULL=关)
 * - max_repos_scan(50)、max_tags_per_repo(20)、session_ttl_days(30)、schema_version
 */

import db from '../db/index.js';

const DEFAULTS = {
  setup_completed: '0',
  login_protection_enabled: '1',
  prune_enabled: '0',
  restart_cron: '',
  max_repos_scan: '50',
  max_tags_per_repo: '20',
  session_ttl_days: '30',
};

export function get(key, fallback = null) {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) {
    if (key in DEFAULTS) return DEFAULTS[key];
    return fallback;
  }
  return row.value;
}

export function set(key, value) {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, String(value));
}

export function getBool(key) {
  return get(key) === '1' || get(key) === 'true';
}

export function getInt(key, fallback = 0) {
  const n = Number.parseInt(get(key, String(fallback)), 10);
  return Number.isNaN(n) ? fallback : n;
}

export function getAll() {
  const rows = db().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
