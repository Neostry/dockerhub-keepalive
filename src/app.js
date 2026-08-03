/**
 * app.js — Express 应用装配
 *
 * - 依赖注入：docker / dockerhub / executor / scheduler 由入口（或测试）创建后传入
 * - 路由挂载顺序：公开路由（setup/status/login/health）→ 认证门槛 → 受保护路由
 * - 生产模式托管前端静态资源 + SPA history fallback
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { securityHeaders, authRequired, notFound, errorHandler } from './middleware/auth.js';
import { publicRouter as authPublic, protectedRouter as authProtected } from './routes/auth.js';
import { createTasksRouter } from './routes/tasks.js';
import { createSettingsRouter } from './routes/settings.js';
import { router as logsRouter } from './routes/logs.js';
import { createSystemRouter } from './routes/system.js';
import { createScheduler } from './services/scheduler.js';
import { createExecutor } from './services/executor.js';
import { createDockerClient } from './services/docker.js';
import { createDockerHubClient } from './services/dockerhub.js';

export function createApp(deps = {}) {
  const docker = deps.docker || createDockerClient();
  const dockerhub = deps.dockerhub || createDockerHubClient();
  const executor = deps.executor || createExecutor({ docker, dockerhub });
  const scheduler = deps.scheduler || createScheduler({ executor, docker });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(securityHeaders);

  // 响应兼容包装：前端统一读 message 字段，契约文档以 error 为主、message 为兼容别名
  app.use((req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && body.error !== undefined && body.message === undefined) {
        return origJson({ ...body, message: body.error });
      }
      return origJson(body);
    };
    next();
  });

  // 公开路由
  app.use('/api', authPublic);
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  // 认证门槛（F5a：登录保护关闭时放行）
  app.use('/api', authRequired);

  // 受保护路由
  app.use('/api', authProtected);
  app.use('/api', createTasksRouter({ scheduler, executor, dockerhub }));
  app.use('/api', createSettingsRouter({ scheduler, executor }));
  app.use('/api', logsRouter);
  app.use('/api', createSystemRouter({ scheduler }));

  // 静态托管（生产）：前端构建产物 + SPA history fallback
  if (config.serveStatic) {
    const dist = path.resolve(config.staticDir);
    if (fs.existsSync(dist)) {
      app.use(express.static(dist, { index: 'index.html' }));
      app.get(/^\/(?!api\/).*/, (req, res) => {
        res.sendFile(path.join(dist, 'index.html'));
      });
    } else {
      console.warn(`[app] 静态目录不存在（${dist}），跳过前端托管（开发模式由 Vite 代理 /api）`);
    }
  }

  // 404 与错误处理
  app.use('/api', notFound);
  app.use(errorHandler);

  return { app, executor, scheduler, docker, dockerhub };
}

export default createApp;
