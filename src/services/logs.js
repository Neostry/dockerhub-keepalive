/**
 * logs.js — 日志与站内信查询（模块 D）
 *
 * 分页查询统一封装：时间倒序 + 可选过滤 + total/page 返回
 */

import db from '../db/index.js';

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

function parsePage(page, pageSize) {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const ps = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.parseInt(pageSize, 10) || PAGE_SIZE_DEFAULT));
  return { p, ps, offset: (p - 1) * ps };
}

/** 日志列表：?task_id&status&page&page_size（倒序；LEFT JOIN tasks 附 task_name） */
export function listLogs({ task_id, status, page, page_size }) {
  const { p, ps, offset } = parsePage(page, page_size);
  const where = [];
  const params = [];
  if (task_id !== undefined && task_id !== '') {
    where.push('l.task_id = ?');
    params.push(Number(task_id));
  }
  if (status) {
    where.push('l.status = ?');
    params.push(status);
  }
  const fromSql = 'FROM execution_logs l LEFT JOIN tasks t ON l.task_id = t.id';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db()
    .prepare(`SELECT COUNT(*) AS c ${fromSql} ${whereSql}`)
    .get(...params).c;
  const items = db()
    .prepare(
      `SELECT l.*, t.name AS task_name ${fromSql} ${whereSql}
       ORDER BY l.started_at DESC, l.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, ps, offset)
    .map(parseLog);
  return { items, total, page: p, page_size: ps };
}

/** 日志详情（含 items 明细；附 task_name） */
export function getLogDetail(id) {
  const log = db()
    .prepare(
      `SELECT l.*, t.name AS task_name
       FROM execution_logs l LEFT JOIN tasks t ON l.task_id = t.id
       WHERE l.id = ?`
    )
    .get(id);
  if (!log) return null;
  const items = db()
    .prepare('SELECT * FROM execution_log_items WHERE log_id = ? ORDER BY id ASC')
    .all(id);
  return { ...parseLog(log), items };
}

function parseLog(row) {
  const out = { ...row };
  if (out.space_check) {
    try { out.space_check = JSON.parse(out.space_check); } catch { /* keep raw */ }
  }
  if (out.cleanup_result) {
    try { out.cleanup_result = JSON.parse(out.cleanup_result); } catch { /* keep raw */ }
  }
  return out;
}

/** 站内信列表：?unread_only&page&page_size（倒序） */
export function listNotifications({ unread_only, page, page_size }) {
  const { p, ps, offset } = parsePage(page, page_size);
  const unreadOnly = unread_only === '1' || unread_only === 'true';
  const where = unreadOnly ? 'WHERE read = 0' : '';
  const total = db().prepare(`SELECT COUNT(*) AS c FROM notifications ${where}`).get().c;
  const unread_count = db().prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get().c;
  const items = db()
    .prepare(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(ps, offset)
    .map((n) => {
      let content = n.content;
      try { content = JSON.parse(n.content); } catch { /* keep raw */ }
      return { ...n, content };
    });
  return { items, total, page: p, page_size: ps, unread_count };
}

export function unreadCount() {
  return db().prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get().c;
}

export function markRead(id) {
  const info = db().prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  return info.changes > 0;
}

export function markAllRead() {
  const info = db().prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  return info.changes;
}
