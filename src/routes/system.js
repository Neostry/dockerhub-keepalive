/**
 * routes/system.js — 模块 E 系统基础路由
 *
 * - GET /api/status：侧边栏状态（用户名/登录保护/可用空间/距下次任务/未读数）
 * - GET /api/health：健康检查（healthcheck 用，不校验登录）
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Router } from 'express';
import config from '../config.js';
import * as settings from '../services/settings.js';
import * as auth from '../services/auth.js';
import * as logs from '../services/logs.js';
import * as tasks from '../services/tasks.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export function createSystemRouter({ scheduler } = {}) {
  const router = Router();

  router.get('/status', (req, res) => {
    let availableBytes = null;
    try {
      const st = fs.statfsSync(config.hostMount);
      availableBytes = st.bavail * st.bsize;
    } catch {
      availableBytes = null; // 非容器环境
    }
    let nextRunAt = null;
    for (const t of tasks.listTasks()) {
      if (!t.enabled) continue;
      const n = scheduler.nextRunAt(t.cron_expr);
      if (n && (!nextRunAt || n < nextRunAt)) nextRunAt = n;
    }
    res.json({
      username: auth.getCurrentUser()?.username ?? null,
      login_protection_enabled: settings.getBool('login_protection_enabled'),
      totp_enabled: !!auth.getCurrentUser()?.totp_enabled,
      disk: { available_bytes: availableBytes },
      next_run_at: nextRunAt,
      unread_count: logs.unreadCount(),
      version: pkg.version,
    });
  });

  return router;
}
