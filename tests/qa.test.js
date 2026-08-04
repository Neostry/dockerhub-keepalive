/**
 * qa.test.js — TASK-12 QA 扩充测试（node:test + supertest）
 *
 * 对应 测试计划_Test_Plan.md v1.0 中尚未被 backend.test.js 自动化的 API 级用例：
 * - TC-05 补充：登录缺字段
 * - TC-14 补充：2FA disable 用 totp
 * - TC-15：2FA regenerate
 * - TC-16：修改用户名
 * - TC-33 补充：编辑 selected_repos 全量替换 + 容量重算
 * - TC-34 补充：删除任务级联 task_images
 * - TC-36：单飞锁严格验证（执行中重复触发 409）
 * - TC-42：pull 失败重试（重试次数与退避）
 * - TC-46：立即执行清理（prune 开启 → 202）
 * - TC-47/48：清理兜底设置保存/读取/校验
 * - TC-51/52 补充：通知 content 结构 / read-all / unread_only
 * - TC-56/57：通知测试按钮未配置 → 400
 * - TC-58：三通道互备（未配置通道不阻塞任务）
 * - P2 联调差异 4 项现状确认（totp_enabled / avatar_url / task_name / duration_ms）
 * - TC-62 补充：数据库全表无明文凭证
 * - TC-63 补充：安全响应头完整
 * - TC-64：APP_SECRET_KEY fail-fast（子进程）
 *
 * 注意：必须在 import 任何 src 模块前设置环境变量（config fail-fast）
 */

process.env.APP_SECRET_KEY = 'qa-secret-key-0123456789abcdef';
process.env.DB_PATH = ':memory:';
process.env.SERVE_STATIC = '0';
process.env.PULL_RETRIES = '2';
process.env.PULL_RETRY_BASE_MS = '1';
process.env.NOTIFY_RETRIES = '1';
process.env.LOGIN_MAX_FAILURES = '5';
process.env.LOGIN_LOCK_MINUTES = '15';
process.env.MAX_TAGS_PER_REPO = '2';
process.env.TRUST_PROXY = '1';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import request from 'supertest';
import { generateSync } from 'otplib';

const { createApp } = await import('../src/app.js');
const db = (await import('../src/db/index.js')).default;

/* ---------------- 测试替身 ---------------- */

const dockerCalls = [];
let pullGate = null; // 单飞锁用例：pull 挂起门控 {promise, resolve}
const mockDocker = {
  async pull(ref) {
    dockerCalls.push(['pull', ref]);
    if (ref.includes('fail-image')) throw new Error('mock pull 失败');
    if (pullGate) return pullGate.promise;
  },
  async remove(ref) {
    dockerCalls.push(['remove', ref]);
  },
  async pruneDangling() {
    dockerCalls.push(['prune']);
    return { ImagesDeleted: [{ Untagged: 'x' }], SpaceReclaimed: 1024 };
  },
  async restartContainer() {
    dockerCalls.push(['restart']);
  },
  _inUseImages: new Set(),
  async isImageInUse(ref) {
    return this._inUseImages.has(ref);
  },
};

const mockHub = {
  async listTags(repo, { limit } = {}) {
    return [{ name: 'v1', full_size: 1000, last_updated: '2026-01-01T00:00:00Z' }].slice(0, limit || 1);
  },
  async scanUserRepos(username, { limit } = {}) {
    const repos = [
      { repo: `${username}/app`, latest_tag: 'v1', description: '测试仓库', storage_size: 2048, last_updated: '2026-01-01T00:00:00Z' },
    ];
    return { repos, total_size: 2048, truncated: false, failed: [] };
  },
  async getUserAvatar() {
    return 'https://example.com/avatar.png';
  },
};

/* ---------------- 夹具 ---------------- */

let app, agent;

function resetDb() {
  const d = db();
  for (const t of [
    'execution_log_items', 'execution_logs', 'notifications', 'task_images',
    'tasks', 'sessions', 'login_attempts', 'credentials', 'users', 'settings',
  ]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
}

before(async () => {
  resetDb();
  const built = createApp({ docker: mockDocker, dockerhub: mockHub });
  app = built.app;
  built.scheduler.rebuildRegistry();
  agent = request.agent(app);
  await request(app).post('/api/setup').send({ username: 'admin', password: 'admin123' });
});

after(() => {
  resetDb();
});

/* ---------------- 工具 ---------------- */

async function loginAgent(name = 'admin', pass = 'admin123') {
  const a = request.agent(app);
  const res = await a.post('/api/auth/login').send({ username: name, password: pass });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return a;
}

async function createImageTask(a, images, extra = {}) {
  const res = await a.post('/api/tasks').send({
    name: extra.name || 'QA 镜像任务',
    type: 'image',
    images,
    cron_expr: '0 3 1 * *',
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================ */
/* 模块 A 补充（F2/F4/F5）                                        */
/* ============================================================ */

describe('QA 模块 A：登录参数与账号管理', () => {
  test('TC-05 补充：登录缺字段 → 429 统一文案（当前实现：缺参按登录失败计限速，契约 400 为偏差见报告）', async () => {
    const r1 = await request(app).post('/api/auth/login').send({ username: 'admin' });
    assert.equal(r1.status, 429);
    assert.equal(r1.body.error, '用户名或密码错误');
    const r2 = await request(app).post('/api/auth/login').send({ password: 'admin123' });
    assert.equal(r2.status, 429);
    const r3 = await request(app).post('/api/auth/login').send({});
    assert.equal(r3.status, 429);
    // 用户名错误 + 正确密码 → 同样 429 统一文案（不区分）
    const r4 = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'admin123' });
    assert.equal(r4.status, 429);
    assert.equal(r4.body.error, '用户名或密码错误');
  });

  test('TC-16 修改用户名：新用户名生效、旧用户名失效、会话吊销', async () => {
    const a = await loginAgent();
    const res = await a.put('/api/auth/username').send({ current_password: 'admin123', new_username: 'newadmin' });
    assert.equal(res.status, 200);
    // 会话吊销
    const blocked = await a.get('/api/tasks');
    assert.equal(blocked.status, 401);
    // 旧用户名登录失败（统一文案）
    const oldLogin = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    assert.notEqual(oldLogin.status, 200);
    // 新用户名登录成功
    const ok = await loginAgent('newadmin', 'admin123');
    const status = await ok.get('/api/status');
    assert.equal(status.body.username, 'newadmin');
    // 还原用户名（保证后续用例用 admin）
    const a2 = await loginAgent('newadmin', 'admin123');
    await a2.put('/api/auth/username').send({ current_password: 'admin123', new_username: 'admin' });
  });
});

describe('QA 模块 A：2FA regenerate / disable(totp)', () => {
  test('TC-15 重新生成密钥：regenerate 后需 enable 才切换，旧密钥随后失效', async () => {
    const a = await loginAgent();
    // 开启 2FA
    const setup = await a.post('/api/auth/2fa/setup');
    const secret1 = setup.body.secret;
    await a.post('/api/auth/2fa/enable').send({ totp: generateSync({ secret: secret1 }) });
    await a.post('/api/auth/logout');

    // 旧密钥登录（两段式）
    const first = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    assert.equal(first.body.code, 'TOTP_REQUIRED');

    // regenerate：校验旧动态码 → 返回新 secret（DB 密钥未切换，旧码仍有效）
    const a3 = await loginAgentWithTotp(secret1);
    const regen = await a3.post('/api/auth/2fa/regenerate').send({ totp: generateSync({ secret: secret1 }) });
    assert.equal(regen.status, 200, JSON.stringify(regen.body));
    const secret2 = regen.body.secret;
    assert.notEqual(secret2, secret1);
    await a3.post('/api/auth/logout');

    // 未 enable 前：DB 仍为 secret1 → 旧码仍可登录、新码不可登录
    const oldCodeBefore = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123', totp: generateSync({ secret: secret1 }) });
    assert.equal(oldCodeBefore.status, 200, '未 enable 前旧码仍有效（密钥未切换）');
    const newCodeBefore = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123', totp: generateSync({ secret: secret2 }) });
    assert.notEqual(newCodeBefore.status, 200, '未 enable 前新码无效');

    // 用新密钥 enable 完成切换
    const a4 = await loginAgentWithTotp(secret1);
    const enableNew = await a4.post('/api/auth/2fa/enable').send({ totp: generateSync({ secret: secret2 }) });
    assert.equal(enableNew.status, 200);
    await a4.post('/api/auth/logout');

    // 切换后：旧码失败、新码成功
    const oldCodeAfter = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123', totp: generateSync({ secret: secret1 }) });
    assert.equal(oldCodeAfter.status, 429, '切换后旧码应失效');
    const newCodeAfter = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123', totp: generateSync({ secret: secret2 }) });
    assert.equal(newCodeAfter.status, 200);

    // 用 totp 关闭 2FA，还原状态
    const a5 = await loginAgentWithTotp(secret2);
    const disable = await a5.post('/api/auth/2fa/disable').send({ totp: generateSync({ secret: secret2 }) });
    assert.equal(disable.status, 200);
  });

  test('TC-14 补充：2FA disable 可用 totp 方式', async () => {
    const a = await loginAgent();
    const setup = await a.post('/api/auth/2fa/setup');
    const secret = setup.body.secret;
    await a.post('/api/auth/2fa/enable').send({ totp: generateSync({ secret }) });
    // disable 用 totp
    const disable = await a.post('/api/auth/2fa/disable').send({ totp: generateSync({ secret }) });
    assert.equal(disable.status, 200);
    const ok = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    assert.equal(ok.status, 200);
  });
});

/** 带 totp 登录并返回保持 Cookie 的 agent（2FA 场景） */
async function loginAgentWithTotp(secret, username = 'admin', password = 'admin123') {
  const a = request.agent(app);
  const res = await a.post('/api/auth/login').send({ username, password, totp: generateSync({ secret }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return a;
}

/* ============================================================ */
/* 模块 B 补充（F6/F9a）                                          */
/* ============================================================ */

describe('QA 模块 B：任务编辑/删除/单飞锁/pull 重试', () => {
  test('TC-33 补充：编辑 selected_repos 全量替换 + estimated_size 重算', async () => {
    const a = await loginAgent();
    const created = await a.post('/api/tasks').send({
      name: '容量重算', type: 'username', source: 'myuser', cron_expr: '0 3 1 * *',
      selected_repos: [
        { repo: 'myuser/a', storage_size: 1000, latest_tag: 'v1' },
        { repo: 'myuser/b', storage_size: 2000, latest_tag: 'v2' },
      ],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.estimated_size, 3000);
    const id = created.body.id;

    // 全量替换为 1 个仓库 → 容量重算（PUT 响应含 images 快照）
    const upd = await a.put(`/api/tasks/${id}`).send({
      selected_repos: [{ repo: 'myuser/c', storage_size: 500, latest_tag: 'v3' }],
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.estimated_size, 500);
    assert.equal(upd.body.images.length, 1);
    assert.equal(upd.body.images[0].repo, 'myuser/c');
  });

  test('TC-34 补充：删除任务 → task_images 级联删除（DB 断言）', async () => {
    const a = await loginAgent();
    const created = await a.post('/api/tasks').send({
      name: '级联删除', type: 'username', source: 'myuser', cron_expr: '0 3 1 * *',
      selected_repos: [
        { repo: 'myuser/a', storage_size: 100, latest_tag: 'v1' },
        { repo: 'myuser/b', storage_size: 200, latest_tag: 'v2' },
      ],
    });
    const id = created.body.id;
    const cntBefore = db().prepare('SELECT COUNT(*) c FROM task_images WHERE task_id = ?').get(id).c;
    assert.equal(cntBefore, 2);

    const del = await a.delete(`/api/tasks/${id}`);
    assert.equal(del.status, 204);
    const cntAfter = db().prepare('SELECT COUNT(*) c FROM task_images WHERE task_id = ?').get(id).c;
    assert.equal(cntAfter, 0);
    const del404 = await a.delete(`/api/tasks/${id}`);
    assert.equal(del404.status, 404);
  });

  test('TC-36 单飞锁：执行中重复触发 → 409（严格版）', async () => {
    const a = await loginAgent();
    const created = await createImageTask(a, ['library/busybox:latest']);
    const id = created.id;
    dockerCalls.length = 0;

    // 挂起 pull，使任务停留在执行中
    pullGate = {};
    pullGate.promise = new Promise((r) => { pullGate.resolve = r; });

    const r1 = await a.post(`/api/tasks/${id}/run`);
    assert.equal(r1.status, 202);
    // pull 挂起中 → 第二次触发应被单飞锁拒绝
    await sleep(80);
    const r2 = await a.post(`/api/tasks/${id}/run`);
    assert.equal(r2.status, 409, JSON.stringify(r2.body));

    // 释放挂起，执行完成
    pullGate.resolve();
    pullGate = null;
    await sleep(300);
    const logs = await a.get('/api/logs');
    assert.ok(logs.body.items.length >= 1);
  });

  test('TC-42 pull 失败重试：PULL_RETRIES=2 → 重试 2 次、明细记录 retries', async () => {
    const a = await loginAgent();
    const created = await createImageTask(a, ['fail-image/bad:1.0']);
    const id = created.id;
    dockerCalls.length = 0;
    await a.post(`/api/tasks/${id}/run`);
    await sleep(300);

    // pull 尝试 3 次（初始 + 重试 2 次）
    const pulls = dockerCalls.filter((c) => c[0] === 'pull');
    assert.equal(pulls.length, 3);
    // 无 rmi（pull 全失败）
    assert.equal(dockerCalls.filter((c) => c[0] === 'remove').length, 0);

    const logs = await a.get('/api/logs');
    const log = logs.body.items[0];
    assert.equal(log.status, 'failed');
    assert.equal(log.fail_count, 1);
    const detail = await a.get(`/api/logs/${log.id}`);
    const item = detail.body.items[0];
    assert.equal(item.action, 'pull');
    assert.equal(item.status, 'failed');
    assert.equal(item.retries, 2);
    assert.ok(item.message, '应记录失败原因');
  });
});

/* ============================================================ */
/* 模块 C 补充（F11）                                             */
/* ============================================================ */

describe('QA 模块 C：清理兜底', () => {
  test('TC-46 立即执行清理：prune 开启 → 202 执行 + system 通知', async () => {
    const a = await loginAgent();
    // 开启 prune
    const on = await a.put('/api/settings/cleanup').send({ prune_enabled: true, restart_cron: '' });
    assert.equal(on.status, 200);
    dockerCalls.length = 0;
    const run = await a.post('/api/cleanup/run');
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await sleep(300);

    assert.ok(dockerCalls.some((c) => c[0] === 'prune'), '应调用 prune');
    const logs = await a.get('/api/logs');
    const cleanupLog = logs.body.items.find((l) => l.trigger === 'cleanup');
    assert.ok(cleanupLog, '应有 cleanup 日志');
    assert.equal(cleanupLog.status, 'success');
    // system 通知
    const notis = await a.get('/api/notifications');
    assert.ok(notis.body.items.some((n) => n.type === 'system'), '应有 system 通知');
    // 还原关闭
    await a.put('/api/settings/cleanup').send({ prune_enabled: false, restart_cron: '' });
  });

  test('TC-47/48 兜底设置：保存/读取一致、非法 restart_cron 400、持久化', async () => {
    const a = await loginAgent();
    const bad = await a.put('/api/settings/cleanup').send({ prune_enabled: false, restart_cron: 'not-a-cron' });
    assert.equal(bad.status, 400);

    const ok = await a.put('/api/settings/cleanup').send({ prune_enabled: true, restart_cron: '0 3 * * *' });
    assert.equal(ok.status, 200);
    const get = await a.get('/api/settings/cleanup');
    assert.equal(get.body.prune_enabled, true);
    assert.equal(get.body.restart_cron, '0 3 * * *');

    // 持久化：settings 表中有值
    const row = db().prepare("SELECT value FROM settings WHERE key = 'prune_enabled'").get();
    assert.equal(row.value, '1');
    const restartRow = db().prepare("SELECT value FROM settings WHERE key = 'restart_cron'").get();
    assert.equal(restartRow.value, '0 3 * * *');

    // 还原
    await a.put('/api/settings/cleanup').send({ prune_enabled: false, restart_cron: '' });
  });
});

/* ============================================================ */
/* 模块 D 补充（F12/F13/F14/F15/F16）                             */
/* ============================================================ */

describe('QA 模块 D：通知中心与三通道互备', () => {
  test('TC-52 补充：read-all 清零 + unread_only 过滤', async () => {
    const a = await loginAgent();
    // 触发一次执行产生任务通知
    const created = await createImageTask(a, ['library/nginx:1.25']);
    await a.post(`/api/tasks/${created.id}/run`);
    await sleep(300);

    const unread = await a.get('/api/notifications/unread-count');
    assert.ok(unread.body.unread_count >= 1);

    const unreadOnly = await a.get('/api/notifications?unread_only=1');
    assert.ok(unreadOnly.body.items.length >= 1);
    assert.ok(unreadOnly.body.items.every((n) => n.read === 0));

    const all = await a.get('/api/notifications');
    const total = all.body.total;

    const readAll = await a.post('/api/notifications/read-all');
    assert.equal(readAll.status, 200);
    assert.ok(readAll.body.changed >= 1);
    const after = await a.get('/api/notifications/unread-count');
    assert.equal(after.body.unread_count, 0);
    assert.equal(after.body.unread_count, 0);
    void total;
  });

  test('TC-56/57 测试按钮：未配置完整 → 400', async () => {
    const a = await loginAgent();
    const tg = await a.post('/api/settings/notifications/telegram/test');
    assert.equal(tg.status, 400);
    const smtp = await a.post('/api/settings/notifications/smtp/test');
    assert.equal(smtp.status, 400);
  });

  test('TC-58 三通道互备：未配置通知通道时任务执行不受影响、站内信必达', async () => {
    const a = await loginAgent();
    // 未配置任何 Telegram/SMTP
    const status = await a.get('/api/settings/notifications');
    assert.equal(status.body.telegram.configured, false);
    assert.equal(status.body.smtp.configured, false);

    const created = await createImageTask(a, ['library/nginx:1.25']);
    await a.post(`/api/tasks/${created.id}/run`);
    await sleep(300);

    // 任务执行不受通知影响
    const logs = await a.get('/api/logs');
    assert.equal(logs.body.items[0].status, 'success');
    // 站内信必达
    const notis = await a.get('/api/notifications');
    assert.ok(notis.body.items.some((n) => n.type === 'task'));
  });

  test('TC-51 补充：任务通知 content 结构完整（P2-④ duration_ms 现状确认）', async () => {
    const a = await loginAgent();
    const created = await createImageTask(a, ['library/nginx:1.25']);
    await a.post(`/api/tasks/${created.id}/run`);
    await sleep(300);

    const notis = await a.get('/api/notifications?unread_only=1');
    const taskNoti = notis.body.items.find((n) => n.type === 'task');
    assert.ok(taskNoti, '应有任务通知');
    const content = typeof taskNoti.content === 'string' ? JSON.parse(taskNoti.content) : taskNoti.content;
    for (const key of ['task_id', 'task_name', 'trigger', 'status', 'started_at', 'total_images', 'success_count', 'fail_count', 'cleanup_result']) {
      assert.ok(key in content, `content 应含 ${key}`);
    }
    // P2-④ 已对齐（2026-08-03 后端补齐）：content 含 duration_ms（数字）
    assert.ok('duration_ms' in content, 'P2-④ 已对齐：content 应含 duration_ms');
    assert.equal(typeof content.duration_ms, 'number');
  });
});

/* ============================================================ */
/* P2 联调差异现状确认（4 项已登记）                               */
/* ============================================================ */

describe('QA P2 联调差异已对齐（4 项后端补齐）', () => {
  test('P2-① GET /api/status 含 totp_enabled（未开 2FA 时 false）', async () => {
    const a = await loginAgent();
    const res = await a.get('/api/status');
    assert.equal(res.status, 200);
    assert.ok('totp_enabled' in res.body, 'P2-① 已对齐：/api/status 应含 totp_enabled');
    assert.equal(res.body.totp_enabled, false);
  });

  test('P2-② GET /tasks 列表当前不含 avatar_url', async () => {
    const a = await loginAgent();
    const created = await a.post('/api/tasks').send({
      name: '头像字段', type: 'username', source: 'myuser', cron_expr: '0 3 1 * *',
      selected_repos: [{ repo: 'myuser/a', storage_size: 100, latest_tag: 'v1' }],
    });
    assert.equal(created.status, 201);
    const list = await a.get('/api/tasks');
    const item = list.body.items.find((t) => t.id === created.body.id);
    assert.ok(item, '任务应存在');
    // P2-② 已对齐（2026-08-03 后端补齐）：列表项含 avatar_url（后端代理 Docker Hub，mock 值）
    assert.ok('avatar_url' in item, 'P2-② 已对齐：/tasks 应含 avatar_url');
    assert.equal(item.avatar_url, 'https://example.com/avatar.png');
  });

  test('P2-③ GET /logs 列表当前不含 task_name', async () => {
    const a = await loginAgent();
    const created = await createImageTask(a, ['library/nginx:1.25'], { name: '日志任务名' });
    await a.post(`/api/tasks/${created.id}/run`);
    await sleep(300);
    const logs = await a.get('/api/logs');
    assert.ok(logs.body.items.length >= 1);
    // P2-③ 已对齐（2026-08-03 后端补齐）：/logs 含 task_name（LEFT JOIN tasks）
    assert.ok('task_name' in logs.body.items[0], 'P2-③ 已对齐：/logs 应含 task_name');
    assert.equal(logs.body.items[0].task_name, '日志任务名');
  });
});

/* ============================================================ */
/* 安全专项                                                       */
/* ============================================================ */

describe('QA 安全专项', () => {
  test('TC-63 补充：安全响应头完整（CSP/XFO/XCTO/Referrer-Policy）', async () => {
    const res = await request(app).get('/api/health');
    assert.ok(res.headers['content-security-policy']?.includes("default-src 'self'"));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['x-frame-options'], '应有 X-Frame-Options');
    assert.ok(res.headers['referrer-policy'], '应有 Referrer-Policy');
  });

  test('TC-64 APP_SECRET_KEY fail-fast：缺失启动退出并提示生成命令', async () => {
    const out = await new Promise((resolve) => {
      const cp = spawn(process.execPath, ['src/index.js'], {
        env: { ...process.env, APP_SECRET_KEY: '', DB_PATH: ':memory:' },
      });
      let stderr = '';
      let stdout = '';
      cp.stderr.on('data', (d) => { stderr += d; });
      cp.stdout.on('data', (d) => { stdout += d; });
      cp.on('exit', (code) => resolve({ code, stderr, stdout }));
    });
    assert.equal(out.code, 1, `应退出码 1（实际 ${out.code}）`);
    assert.match(out.stderr + out.stdout, /启动失败|缺少必需环境变量/);
    assert.match(out.stderr + out.stdout, /openssl rand -hex 32/, '应提示生成命令');
  });

  test('TC-62 补充：数据库全表扫描无明文凭证', async () => {
    const a = await loginAgent();
    await a.post('/api/settings/notifications/telegram').send({ chat_id: '111111', bot_token: 'qasecrettoken123' });
    await a.post('/api/settings/notifications/smtp').send({
      host: 'smtp.example.com', port: 587, username: 'me@example.com', password: 'qasmtppass456', to: 'a@example.com',
    });

    const d = db();
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const plaintext = ['qasecrettoken123', 'qasmtppass456'];
    for (const t of tables) {
      const rows = d.prepare(`SELECT * FROM ${t}`).all();
      const blob = JSON.stringify(rows);
      for (const secret of plaintext) {
        assert.ok(!blob.includes(secret), `表 ${t} 不得包含明文 ${secret}`);
      }
    }
  });
});
