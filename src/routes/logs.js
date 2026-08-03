/**
 * routes/logs.js — 模块 D 日志与站内信路由
 *
 * - GET /logs、/logs/:id：执行日志（含逐镜像明细），时间倒序分页
 * - GET /notifications、已读、全部已读、未读数：站内信通知中心
 */

import { Router } from 'express';
import * as logs from '../services/logs.js';

export const router = Router();

/* ---------------- 执行日志 ---------------- */

router.get('/logs', (req, res) => {
  const { task_id, status, page, page_size } = req.query;
  res.json(logs.listLogs({ task_id, status, page, page_size }));
});

router.get('/logs/:id', (req, res) => {
  const log = logs.getLogDetail(Number(req.params.id));
  if (!log) return res.status(404).json({ error: '日志不存在' });
  res.json(log);
});

/* ---------------- 站内信通知中心 ---------------- */

router.get('/notifications', (req, res) => {
  const { unread_only, page, page_size } = req.query;
  res.json(logs.listNotifications({ unread_only, page, page_size }));
});

router.post('/notifications/:id/read', (req, res) => {
  const ok = logs.markRead(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '通知不存在' });
  res.json({ ok: true });
});

router.post('/notifications/read-all', (req, res) => {
  const changed = logs.markAllRead();
  res.json({ ok: true, changed });
});

router.get('/notifications/unread-count', (req, res) => {
  res.json({ unread_count: logs.unreadCount() });
});
