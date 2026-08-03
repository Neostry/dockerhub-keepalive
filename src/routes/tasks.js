/**
 * routes/tasks.js — 模块 B 任务配置与扫描路由
 *
 * - 任务 CRUD（变更后重建调度注册表）
 * - POST /tasks/:id/run 立即执行（P1/F9a，202 入队）
 * - POST /scan/username 用户名扫描（元信息 + 合计容量 + 截断/失败标注）
 *
 * 依赖注入：scheduler（nextRunAt/rebuildRegistry）、executor（enqueue）、dockerhub（扫描/头像）
 */

import { Router } from 'express';
import * as tasks from '../services/tasks.js';
import { createDockerHubClient } from '../services/dockerhub.js';

export function createTasksRouter({ scheduler, executor, dockerhub = createDockerHubClient() } = {}) {
  const router = Router();

  /* ---------------- 任务列表 ---------------- */

  router.get('/tasks', async (req, res) => {
    const items = tasks.listTasks().map((t) => ({
      ...t,
      next_run_at: t.enabled ? scheduler.nextRunAt(t.cron_expr) : null,
    }));
    // avatar_url（P2 联调）：username 型经后端代理 Docker Hub /v2/users/{name}/ 取 gravatar_url；
    // 浏览器直连被 CORS 拦截（前端已实测），失败回退 null（前端显示默认图标）
    await Promise.all(
      items.map(async (t) => {
        if (t.type === 'username' && t.source) {
          t.avatar_url = await dockerhub.getUserAvatar(t.source).catch(() => null);
        } else {
          t.avatar_url = null;
        }
      })
    );
    res.json({ items });
  });

  /* ---------------- 新建任务 ---------------- */

  router.post('/tasks', (req, res) => {
    const body = req.body || {};
    const err = validateTaskInput(body);
    if (err) return res.status(400).json({ error: err });
    try {
      const id = tasks.createTask(body, { onChanged: () => scheduler.rebuildRegistry() });
      res.status(201).json(tasks.getTask(id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------------- 任务详情 ---------------- */

  router.get('/tasks/:id', (req, res) => {
    const task = tasks.getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const { images, ...rest } = task;
    const repos = images.map((i) => ({
      repo: i.repo,
      tag: i.tag,
      latest_tag: i.latest_tag,
      description: i.description,
      storage_size: i.storage_size,
      last_updated: i.last_updated,
    }));
    res.json({
      ...rest,
      next_run_at: rest.enabled ? scheduler.nextRunAt(rest.cron_expr) : null,
      repos,
    });
  });

  /* ---------------- 编辑任务 ---------------- */

  router.put('/tasks/:id', (req, res) => {
    const body = req.body || {};
    if (body.cron_expr !== undefined) {
      const cronErr = tasks.validateCron(body.cron_expr);
      if (cronErr) return res.status(400).json({ error: cronErr });
    }
    try {
      const task = tasks.updateTask(Number(req.params.id), body, {
        onChanged: () => scheduler.rebuildRegistry(),
      });
      res.json(task);
    } catch (e) {
      res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message });
    }
  });

  /* ---------------- 删除任务 ---------------- */

  router.delete('/tasks/:id', (req, res) => {
    try {
      tasks.deleteTask(Number(req.params.id), { onChanged: () => scheduler.rebuildRegistry() });
      res.status(204).end();
    } catch (e) {
      res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message });
    }
  });

  /* ---------------- 立即执行（P1/F9a，接口预留） ---------------- */

  router.post('/tasks/:id/run', (req, res) => {
    const task = tasks.getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const result = executor.enqueue(task, 'manual');
    if (!result.queued) return res.status(409).json({ error: result.reason });
    res.status(202).json({ ok: true, message: '已加入执行队列' });
  });

  /* ---------------- 用户名扫描 ---------------- */

  router.post('/scan/username', async (req, res) => {
    const { username, limit } = req.body || {};
    if (!username || typeof username !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(username)) {
      return res.status(400).json({ error: '用户名格式非法（小写字母/数字/._-）' });
    }
    const lim = limit === undefined || limit === null ? undefined : Math.max(1, Number(limit));
    try {
      const result = await dockerhub.scanUserRepos(username, { limit: lim });
      const avatar = await dockerhub.getUserAvatar(username);
      res.json({ ...result, username, avatar });
    } catch (e) {
      res.status(502).json({ error: `扫描失败：${e.message}` });
    }
  });

  return router;
}

/** 任务输入校验：返回错误文案或 null */
function validateTaskInput(body) {
  if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
    return '任务名称不能为空';
  }
  if (body.type !== 'username' && body.type !== 'image') {
    return '任务类型必须是 username 或 image';
  }
  if (!body.cron_expr) return 'cron 表达式不能为空';
  const cronErr = tasks.validateCron(body.cron_expr);
  if (cronErr) return cronErr;
  if (body.type === 'username') {
    if (!body.source || typeof body.source !== 'string') return '缺少用户名（source）';
    if (!Array.isArray(body.selected_repos) || body.selected_repos.length === 0) {
      return '请选择至少一个仓库';
    }
    for (const r of body.selected_repos) {
      if (!r || !r.repo) return '仓库列表包含非法项';
    }
  } else {
    if (!Array.isArray(body.images) || body.images.length === 0) return '请添加至少一个镜像';
    for (const line of body.images) {
      const r = tasks.validateImageLine(line);
      if (!r.ok) return `${r.reason}：${line}`;
    }
  }
  return null;
}
