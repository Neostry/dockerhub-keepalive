/**
 * index.js — 服务入口
 *
 * 启动流程：校验环境（config fail-fast）→ 打开 SQLite → 清理过期会话
 * → 构建 docker/dockerhub/executor/scheduler → 初始重建调度注册表
 * → 启动 HTTP 服务（WEB_PORT）
 */

import config from './config.js';
import { openDb } from './db/index.js';
import * as auth from './services/auth.js';
import createApp from './app.js';

const db = openDb();
auth.cleanupExpiredSessions();

const { app, scheduler } = createApp();
scheduler.rebuildRegistry();

const server = app.listen(config.port, () => {
  console.log(`[server] Docker Hub 镜像保活服务已启动：http://127.0.0.1:${config.port}`);
  console.log(`[server] 时区：${config.tz}；数据文件：${config.dbPath}`);
});

function shutdown() {
  console.log('[server] 正在关闭…');
  try {
    for (const cron of scheduler.registry.values()) cron.stop();
  } catch {
    /* ignore */
  }
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  // 兜底：5s 内未能优雅退出则强制退出
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
