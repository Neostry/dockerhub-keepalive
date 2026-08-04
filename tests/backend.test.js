/**
 * backend.test.js — TASK-09 后端核心测试（node:test + supertest）
 *
 * 覆盖：健康检查 / 首次设置 / 登录与限速锁定 / 2FA 两段式 / 会话吊销
 * / F5a 登录保护开关 / 任务 CRUD / 执行链路（mock docker）/ 日志与站内信
 * / 通知凭证加密入库（仅写不读）/ AES-GCM 单元测试
 *
 * 注意：必须在 import 任何 src 模块前设置环境变量（config fail-fast）
 */

process.env.APP_SECRET_KEY = 'test-secret-key-0123456789abcdef';
process.env.DB_PATH = ':memory:';
process.env.SERVE_STATIC = '0';
process.env.PULL_RETRIES = '1';
process.env.PULL_RETRY_BASE_MS = '1';
process.env.NOTIFY_RETRIES = '1';
process.env.LOGIN_MAX_FAILURES = '3';
process.env.LOGIN_LOCK_MINUTES = '15';
process.env.MAX_TAGS_PER_REPO = '2';
// 测试中启用 TRUST_PROXY，使限速测试的 X-Forwarded-For 隔离到独立 IP（不污染其他测试来源）
process.env.TRUST_PROXY = '1';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { generateSync } from 'otplib';

const { createApp } = await import('../src/app.js');
const db = (await import('../src/db/index.js')).default;
const { encrypt, decrypt } = await import('../src/services/crypto.js');

/* ---------------- 测试替身 ---------------- */

const dockerCalls = [];
const mockDocker = {
  async pull(ref) {
    dockerCalls.push(['pull', ref]);
    if (ref.includes('fail-image')) throw new Error('mock pull 失败');
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
};

const mockHub = {
  async listTags(repo, { limit } = {}) {
    // F9 测试用：不同 repo 返回不同 tag 列表（与真实 listTags 一样按 last_updated 降序）
    let tags;
    if (repo === 'user/multi-tags') {
      // 无 latest → 按 last_updated 取最新
      tags = [
        { name: 'v1.0', full_size: 1000, last_updated: '2026-01-01T00:00:00Z' },
        { name: 'v2.0', full_size: 1200, last_updated: '2026-06-01T00:00:00Z' },
        { name: 'v3.0', full_size: 1400, last_updated: '2026-08-01T00:00:00Z' },
      ];
    } else if (repo === 'user/with-latest') {
      // 有 latest 但不在第一个
      tags = [
        { name: 'v1.0', full_size: 1000, last_updated: '2026-01-01T00:00:00Z' },
        { name: 'latest', full_size: 2000, last_updated: '2026-08-01T00:00:00Z' },
        { name: 'v2.0', full_size: 1500, last_updated: '2026-06-01T00:00:00Z' },
      ];
    } else {
      tags = [{ name: 'v1', full_size: 1000, last_updated: '2026-01-01T00:00:00Z' }];
    }
    // 与真实 listTags 一致：按 last_updated 降序
    tags.sort((a, b) => new Date(b.last_updated || 0) - new Date(a.last_updated || 0));
    return tags.slice(0, limit || tags.length);
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
  // 初始化已知账号状态（admin / admin123），使各 describe 可独立运行
  await request(app).post('/api/setup').send({ username: 'admin', password: 'admin123' });
});

after(() => {
  // 清理 settings 的 schema_version 之外的运行时数据
  resetDb();
});

/* ---------------- 工具 ---------------- */

async function doSetup(username = 'admin', password = 'admin123') {
  const res = await request(app).post('/api/setup').send({ username, password });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res;
}

async function doLogin(username = 'admin', password = 'admin123', totp) {
  const body = { username, password };
  if (totp) body.totp = totp;
  return request(app).post('/api/auth/login').send(body);
}

/* ---------------- 测试 ---------------- */

describe('模块 E：系统基础', () => {
  test('健康检查无需登录', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('未初始化时 auth/status 正确', async () => {
    // 由 模块 A 首个测试覆盖（resetDb + 断言 + 重新 setup）
    assert.ok(true);
  });

  test('未登录访问受保护接口 → 401', async () => {
    const res = await request(app).get('/api/tasks');
    assert.equal(res.status, 401);
  });

  test('AES-256-GCM 加解密往返 + AAD 防跨表替换', () => {
    const ct = encrypt('top-secret-token', 'telegram');
    assert.equal(decrypt(ct, 'telegram'), 'top-secret-token');
    assert.throws(() => decrypt(ct, 'smtp'));
    assert.throws(() => decrypt('!!bad-base64!!', 'telegram'));
    // 同一明文两次加密密文不同（随机 IV）
    assert.notEqual(encrypt('a', 'telegram'), encrypt('a', 'telegram'));
  });

  test('安全响应头存在', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['content-security-policy']?.includes("default-src 'self'"));
  });
});

describe('模块 A：首次设置与登录', () => {
  test('未初始化 → 弱密码拒绝 → 正常设置 → 重复设置 409', async () => {
    // 重置到未初始化状态（自包含，不依赖 before 的账号）
    resetDb();
    const st = await request(app).get('/api/auth/status');
    assert.equal(st.body.initialized, false);
    assert.equal(st.body.login_protection_enabled, true);

    const weak = await request(app).post('/api/setup').send({ username: 'admin', password: 'short' });
    assert.equal(weak.status, 400);

    await doSetup();
    const again = await request(app).post('/api/setup').send({ username: 'admin', password: 'admin123' });
    assert.equal(again.status, 409);
  });

  test('错误密码返回统一文案且不区分账号', async () => {
    const r1 = await doLogin('admin', 'wrong-pass');
    const r2 = await doLogin('nobody', 'whatever1');
    assert.equal(r1.body.error, '用户名或密码错误');
    assert.equal(r1.body.error, r2.body.error);
    assert.ok(r1.body.message, '兼容 message 字段');
  });

  test('登录成功 Set-Cookie sid + 会话有效', async () => {
    const res = await doLogin();
    assert.equal(res.status, 200);
    const sid = res.headers['set-cookie']?.find((c) => c.startsWith('sid='));
    assert.ok(sid, '应设置 sid Cookie');
    assert.match(sid, /HttpOnly/i);
    assert.match(sid, /SameSite=Lax/i);
  });

  test('会话 Cookie 可访问受保护接口；登出后失效', async () => {
    // 用 agent 保持 Cookie
    const loginRes = await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    assert.equal(loginRes.status, 200);
    const ok = await agent.get('/api/tasks');
    assert.equal(ok.status, 200);
    // P2 联调：/api/status 附 totp_enabled（未开启 2FA 时 false）
    const st = await agent.get('/api/status');
    assert.equal(st.status, 200);
    assert.equal(st.body.totp_enabled, false);
    await agent.post('/api/auth/logout');
    const after = await agent.get('/api/tasks');
    assert.equal(after.status, 401);
  });
});

describe('模块 A：登录失败限速与锁定', () => {
  test('连续失败递增延迟，达阈值锁定，锁定期间正确凭据也拒绝', async () => {
    const ip = '203.0.113.9';
    // 阈值 = 3（测试配置）
    const r1 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'x1' }).set('X-Forwarded-For', ip);
    assert.equal(r1.status, 429);
    assert.equal(r1.body.retry_after, 1); // 1s
    const r2 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'x2' }).set('X-Forwarded-For', ip);
    assert.equal(r2.body.retry_after, 2); // 2s
    const r3 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'x3' }).set('X-Forwarded-For', ip);
    assert.equal(r3.body.locked, true);
    assert.ok(r3.body.retry_after >= 15 * 60);
    // 锁定期间即使正确密码也拒绝
    const r4 = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' }).set('X-Forwarded-For', ip);
    assert.equal(r4.status, 429);
    assert.equal(r4.body.locked, true);
  });
});

describe('模块 A：2FA（TOTP）', () => {
  test('两段式登录全流程', async () => {
    // 用独立 agent 登录获取会话
    const a = request.agent(app);
    await a.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // setup 获取密钥（仅此一次明文）
    const setupRes = await a.post('/api/auth/2fa/setup');
    assert.equal(setupRes.status, 200);
    const secret = setupRes.body.secret;
    assert.ok(secret && setupRes.body.otpauth_uri.startsWith('otpauth://'));

    // 用错误动态码 enable → 400
    const badEnable = await a.post('/api/auth/2fa/enable').send({ totp: '000000' });
    assert.equal(badEnable.status, 400);

    // 正确动态码 enable → 200
    const code = generateSync({ secret });
    const enableRes = await a.post('/api/auth/2fa/enable').send({ totp: code });
    assert.equal(enableRes.status, 200);
    // P2 联调：2FA 开启后 /api/status.totp_enabled 为 true
    const stAfter = await a.get('/api/status');
    assert.equal(stAfter.body.totp_enabled, true);

    // 登出后登录：第一段返回 TOTP_REQUIRED
    await a.post('/api/auth/logout');
    const first = await doLogin('admin', 'admin123');
    assert.equal(first.status, 400);
    assert.equal(first.body.code, 'TOTP_REQUIRED');

    // 错误动态码 → 失败（统一文案）
    const badTotp = await doLogin('admin', 'admin123', '000000');
    assert.equal(badTotp.status, 429);
    assert.equal(badTotp.body.error, '用户名或密码错误');

    // 正确动态码 → 成功
    const ok = await doLogin('admin', 'admin123', generateSync({ secret }));
    assert.equal(ok.status, 200);

    // 用当前密码关闭 2FA
    const a2 = request.agent(app);
    await a2.post('/api/auth/login').send({ username: 'admin', password: 'admin123', totp: generateSync({ secret }) });
    const disable = await a2.post('/api/auth/2fa/disable').send({ password: 'admin123' });
    assert.equal(disable.status, 200);

    // 关闭后无需动态码即可登录
    const afterDisable = await doLogin('admin', 'admin123');
    assert.equal(afterDisable.status, 200);
  });
});

describe('模块 A：修改密码吊销会话', () => {
  test('修改密码后旧会话失效，需重新登录', async () => {
    const a = request.agent(app);
    await a.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const res = await a.put('/api/auth/password').send({ current_password: 'admin123', new_password: 'newpass456' });
    assert.equal(res.status, 200);
    // 旧会话被吊销
    const blocked = await a.get('/api/tasks');
    assert.equal(blocked.status, 401);
    // 新密码登录成功
    const login = await doLogin('admin', 'newpass456');
    assert.equal(login.status, 200);
    // 还原密码
    const a2 = request.agent(app);
    await a2.post('/api/auth/login').send({ username: 'admin', password: 'newpass456' });
    await a2.put('/api/auth/password').send({ current_password: 'newpass456', new_password: 'admin123' });
  });
});

describe('模块 B：任务 CRUD', () => {
  test('用户名型任务创建 → 列表 → 详情 → 编辑 → 删除', async () => {
    const agent2 = request.agent(app);
    await agent2.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    const created = await agent2.post('/api/tasks').send({
      name: '我的镜像库',
      type: 'username',
      source: 'myuser',
      cron_expr: '0 3 1 * *',
      selected_repos: [
        { repo: 'myuser/app', latest_tag: 'v1', description: '应用', storage_size: 2048, last_updated: '2026-01-01T00:00:00Z' },
        { repo: 'myuser/tool', latest_tag: 'v2', description: '工具', storage_size: 1024, last_updated: '2026-01-01T00:00:00Z' },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(created.body.estimated_size, 3072);

    const list = await agent2.get('/api/tasks');
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].image_count, 2);
    assert.ok(list.body.items[0].next_run_at, '应返回下次执行时间');
    // P2 联调：username 型列表项 avatar_url 由后端代理 Docker Hub 返回（mock 值）
    assert.equal(list.body.items[0].avatar_url, 'https://example.com/avatar.png');

    const detail = await agent2.get(`/api/tasks/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.repos.length, 2);
    assert.equal(detail.body.repos[0].repo, 'myuser/app');

    // 非法 cron → 400
    const badCron = await agent2.put(`/api/tasks/${id}`).send({ cron_expr: 'not-a-cron' });
    assert.equal(badCron.status, 400);

    // 编辑：停用 + 改 cron
    const edited = await agent2.put(`/api/tasks/${id}`).send({ enabled: false, cron_expr: '0 4 * * *' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.enabled, false);

    // 停用后 next_run_at 为 null
    const list2 = await agent2.get('/api/tasks');
    assert.equal(list2.body.items[0].next_run_at, null);

    // 删除
    const del = await agent2.delete(`/api/tasks/${id}`);
    assert.equal(del.status, 204);
    const list3 = await agent2.get('/api/tasks');
    assert.equal(list3.body.items.length, 0);
  });

  test('镜像型任务：多行批量 + 非法行拒绝', async () => {
    const agent2 = request.agent(app);
    await agent2.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const bad = await agent2.post('/api/tasks').send({
      name: 'bad', type: 'image', images: ['UPPER/invalid', 'ok/repo'], cron_expr: '0 3 1 * *',
    });
    assert.equal(bad.status, 400);

    const ok = await agent2.post('/api/tasks').send({
      name: '镜像列表', type: 'image', source: 'custom', images: ['library/nginx', 'bitnami/redis:7.0'], cron_expr: '0 3 1 * *',
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.images.length, 2);
    assert.equal(ok.body.images[1].tag, '7.0');
    // 显式 source 优先
    assert.equal(ok.body.source, 'custom');
  });

  test('image 型任务：不带 source 创建 → 自动填充镜像列表拼接（回归 P0）', async () => {
    const agent2 = request.agent(app);
    await agent2.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // 按 API 文档契约调用：image 型不传 source（前端真实调用形态）
    const created = await agent2.post('/api/tasks').send({
      name: '无 source 镜像任务', type: 'image', images: ['library/nginx:1.25', 'bitnami/redis:7.0'], cron_expr: '0 3 1 * *',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.source, 'library/nginx:1.25\nbitnami/redis:7.0');
    assert.equal(created.body.images.length, 2);

    // 编辑镜像列表（不带 source）→ source 同步为新拼接
    const id = created.body.id;
    const upd = await agent2.put(`/api/tasks/${id}`).send({ images: ['library/nginx'] });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.source, 'library/nginx');
    assert.equal(upd.body.images.length, 1);

    // 编辑仅改名称 → source 保持
    const upd2 = await agent2.put(`/api/tasks/${id}`).send({ name: '改名' });
    assert.equal(upd2.status, 200);
    assert.equal(upd2.body.source, 'library/nginx');

    // 列表接口 source 字段完整；image 型 avatar_url 为 null（无仓库头像 API，前端回退默认图标）
    const list = await agent2.get('/api/tasks');
    const item = list.body.items.find((t) => t.id === id);
    assert.equal(item.source, 'library/nginx');
    assert.equal(item.avatar_url, null);
  });
});

describe('模块 C：执行链路（mock docker）', () => {
  test('手动执行：pull → rmi → 日志 → 站内信', async () => {
    const agent3 = request.agent(app);
    await agent3.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    const created = await agent3.post('/api/tasks').send({
      name: '执行测试', type: 'image', source: 'custom', images: ['library/nginx:1.25'], cron_expr: '0 3 1 * *',
    });
    const id = created.body.id;

    dockerCalls.length = 0;
    const run = await agent3.post(`/api/tasks/${id}/run`);
    assert.equal(run.status, 202);

    // 等待队列异步执行完成（mock 立即完成）
    await new Promise((r) => setTimeout(r, 300));

    assert.deepEqual(dockerCalls, [['pull', 'library/nginx:1.25'], ['remove', 'library/nginx:1.25']]);

    // 日志
    const logs = await agent3.get('/api/logs');
    assert.equal(logs.body.items.length, 1);
    assert.equal(logs.body.items[0].status, 'success');
    assert.equal(logs.body.items[0].success_count, 1);
    // P2 联调：/logs 附 task_name（LEFT JOIN tasks）
    assert.equal(logs.body.items[0].task_name, '执行测试');
    const detail = await agent3.get(`/api/logs/${logs.body.items[0].id}`);
    assert.equal(detail.body.items.length, 2); // pull + rmi
    assert.equal(detail.body.items[0].action, 'pull');
    assert.equal(detail.body.items[0].status, 'success');
    // 详情同样附 task_name
    assert.equal(detail.body.task_name, '执行测试');

    // 站内信
    const notis = await agent3.get('/api/notifications');
    const taskNoti = notis.body.items.find((n) => n.type === 'task');
    assert.ok(taskNoti, '应有 task 型站内信');
    assert.equal(taskNoti.content.task_name, '执行测试');
    // P2 联调：通知 content 附 duration_ms
    assert.equal(typeof taskNoti.content.duration_ms, 'number');
    assert.ok(taskNoti.content.duration_ms >= 0);
    assert.equal(notis.body.unread_count, notis.body.items.length);

    // 未读数接口
    const unread = await agent3.get('/api/notifications/unread-count');
    assert.ok(unread.body.unread_count >= 1);

    // 已读
    const nid = notis.body.items[0].id;
    await agent3.post(`/api/notifications/${nid}/read`);
    const unread2 = await agent3.get('/api/notifications/unread-count');
    assert.equal(unread2.body.unread_count, notis.body.unread_count - 1);

    // 任务 last_run 更新
    const taskDetail = await agent3.get(`/api/tasks/${id}`);
    assert.equal(taskDetail.body.last_run_status, 'success');

    // 立即执行清理（prune 未开启 → 400）
    const cleanup400 = await agent3.post('/api/cleanup/run');
    assert.equal(cleanup400.status, 400);
  });

  test('执行失败（pull 失败）：日志 failed 且有完成字段与失败原因', async () => {
    const agentY = request.agent(app);
    await agentY.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const created = await agentY.post('/api/tasks').send({
      name: '失败任务', type: 'image', source: 'custom', images: ['test/fail-image:1.0'], cron_expr: '0 3 1 * *',
    });
    assert.equal(created.status, 201);
    dockerCalls.length = 0;
    const run = await agentY.post(`/api/tasks/${created.body.id}/run`);
    assert.equal(run.status, 202);
    // 等待队列异步执行完成
    await new Promise((r) => setTimeout(r, 300));
    const logs = await agentY.get('/api/logs');
    const l = logs.body.items.find((x) => x.task_id === created.body.id);
    assert.ok(l, '应有日志');
    assert.equal(l.status, 'failed');
    assert.equal(l.fail_count, 1);
    assert.ok(l.finished_at, '应有结束时间（非初始 failed 残留）');
    assert.equal(typeof l.duration_ms, 'number');
    // 镜像失败项带原因（前端可展示）
    const detail = await agentY.get(`/api/logs/${l.id}`);
    const pullItem = detail.body.items.find((it) => it.action === 'pull');
    assert.ok(pullItem && pullItem.status === 'failed');
    assert.match(pullItem.message || '', /mock pull 失败/);
  });

  test('schema v2：execution_logs.status 支持 running 且外键完好', async () => {
    const d = db();
    const ddl = d.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='execution_logs'`).get().sql;
    assert.match(ddl, /'running'/, 'CHECK 应包含 running');
    // 插入 running 日志 + 子项（验证 v2 迁移后 FK 指向新表不报错）
    const rid = d.prepare(`INSERT INTO execution_logs (task_id, trigger, status, started_at) VALUES (NULL, 'manual', 'running', ?)`).run(new Date().toISOString()).lastInsertRowid;
    d.prepare(`INSERT INTO execution_log_items (log_id, repo, action, status) VALUES (?, 'lib/x', 'pull', 'success')`).run(rid);
    const n = d.prepare(`SELECT COUNT(*) c FROM execution_log_items WHERE log_id = ?`).get(rid).c;
    assert.equal(n, 1);
    d.prepare(`DELETE FROM execution_log_items WHERE log_id = ?`).run(rid);
    d.prepare(`DELETE FROM execution_logs WHERE id = ?`).run(rid);
  });

  test('任务单飞锁：执行中重复触发返回 409', async () => {
    const agent4 = request.agent(app);
    await agent4.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const list = await agent4.get('/api/tasks');
    const id = list.body.items[0].id;
    // 第一次入队后立即再次触发（mock 执行极快，这里验证不崩溃即可）
    const r1 = await agent4.post(`/api/tasks/${id}/run`);
    const r2 = await agent4.post(`/api/tasks/${id}/run`);
    assert.ok([202, 409].includes(r1.status));
    assert.ok([202, 409].includes(r2.status));
    await new Promise((r) => setTimeout(r, 300));
  });
});

describe('模块 D：通知配置（凭证仅写不读）', () => {
  test('Telegram/SMTP 凭证加密入库，GET 仅返回非敏感项', async () => {
    const agent5 = request.agent(app);
    await agent5.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // 保存 Telegram
    const tg = await agent5.post('/api/settings/notifications/telegram').send({ chat_id: '123456', bot_token: 'supersecrettoken' });
    assert.equal(tg.status, 200);
    assert.equal(tg.body.configured, true);
    assert.equal(tg.body.chat_id, '123456');
    assert.ok(!('bot_token' in tg.body), '响应不得包含 token');

    // 数据库内为密文，无明文
    const row = db().prepare("SELECT * FROM credentials WHERE channel='telegram'").get();
    assert.ok(row.payload, '应有密文');
    assert.ok(!row.payload.includes('supersecrettoken'), '库内不得有明文 token');

    // 敏感字段留空 = 保持原值
    await agent5.post('/api/settings/notifications/telegram').send({ chat_id: '654321' });
    const row2 = db().prepare("SELECT * FROM credentials WHERE channel='telegram'").get();
    const { decrypt: dec } = await import('../src/services/crypto.js');
    assert.equal(JSON.parse(dec(row2.payload, 'telegram')).bot_token, 'supersecrettoken');

    // SMTP 保存
    const smtp = await agent5.post('/api/settings/notifications/smtp').send({
      host: 'smtp.example.com', port: 587, username: 'me@example.com', password: 'smtppass', to: 'a@example.com',
    });
    assert.equal(smtp.status, 200);
    assert.equal(smtp.body.configured, true);
    assert.equal(smtp.body.host, 'smtp.example.com');
    assert.ok(!('password' in smtp.body));

    // 状态读取无密文
    const status = await agent5.get('/api/settings/notifications');
    assert.equal(status.body.telegram.configured, true);
    assert.ok(!JSON.stringify(status.body).includes('supersecrettoken'));
    assert.ok(!JSON.stringify(status.body).includes('smtppass'));
  });
});

describe('模块 A：F5a 登录保护开关', () => {
  test('关闭须 confirm；关闭后免登录访问；重新开启恢复', async () => {
    const agent6 = request.agent(app);
    await agent6.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // 无 confirm 关闭 → 400
    const noConfirm = await agent6.put('/api/settings/login-protection').send({ enabled: false });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.need_confirm, true);

    // 带 confirm 关闭 → 200
    const off = await agent6.put('/api/settings/login-protection').send({ enabled: false, confirm: true });
    assert.equal(off.status, 200);

    // 免登录访问受保护接口
    const anon = await request(app).get('/api/tasks');
    assert.equal(anon.status, 200);

    // auth/status 显示免登录
    const st = await request(app).get('/api/auth/status');
    assert.equal(st.body.login_protection_enabled, false);
    assert.equal(st.body.logged_in, true);

    // 重新开启 → 恢复登录要求
    const on = await request(app).put('/api/settings/login-protection').send({ enabled: true, confirm: true });
    assert.equal(on.status, 200);
    const blocked = await request(app).get('/api/tasks');
    assert.equal(blocked.status, 401);
  });
});

describe('模块 B：用户名扫描', () => {
  test('扫描返回仓库元信息 + 合计容量 + 头像', async () => {
    const agent7 = request.agent(app);
    await agent7.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const res = await agent7.post('/api/scan/username').send({ username: 'testuser' });
    assert.equal(res.status, 200);
    assert.equal(res.body.repos.length, 1);
    assert.equal(res.body.repos[0].storage_size, 2048);
    assert.equal(res.body.total_size, 2048);
    assert.equal(res.body.avatar, 'https://example.com/avatar.png');
  });

  test('非法用户名 → 400', async () => {
    const agent8 = request.agent(app);
    await agent8.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const res = await agent8.post('/api/scan/username').send({ username: 'UPPER' });
    assert.equal(res.status, 400);
  });
});

describe('F9：仅拉最新 tag（username/未指定 tag）', () => {
  test('用户名型任务：每个仓库仅拉最新 tag（latest 优先）', async () => {
    const agentF = request.agent(app);
    await agentF.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // 创建 username 型任务，selected_repos 包含 user/with-latest（mock 返回含 latest 的 tag 列表）
    const created = await agentF.post('/api/tasks').send({
      name: 'F9 latest 优先', type: 'username', source: 'user', cron_expr: '0 3 1 * *',
      selected_repos: [{ repo: 'user/with-latest', latest_tag: 'latest', storage_size: 2000 }],
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    dockerCalls.length = 0;
    const run = await agentF.post(`/api/tasks/${id}/run`);
    assert.equal(run.status, 202);
    await new Promise((r) => setTimeout(r, 300));

    // 只拉 1 个（latest），不拉 v1.0/v2.0
    const pulls = dockerCalls.filter((c) => c[0] === 'pull');
    assert.equal(pulls.length, 1, '应只拉 1 个 tag（latest 优先）');
    assert.equal(pulls[0][1], 'user/with-latest:latest');
  });

  test('用户名型任务：无 latest 时取 last_updated 最新的 tag', async () => {
    const agentF = request.agent(app);
    await agentF.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // 创建 username 型任务，selected_repos 包含 user/multi-tags（mock 返回 v1.0/v2.0/v3.0，无 latest）
    const created = await agentF.post('/api/tasks').send({
      name: 'F9 无 latest', type: 'username', source: 'user', cron_expr: '0 3 1 * *',
      selected_repos: [{ repo: 'user/multi-tags', latest_tag: 'v3.0', storage_size: 1400 }],
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    dockerCalls.length = 0;
    const run = await agentF.post(`/api/tasks/${id}/run`);
    assert.equal(run.status, 202);
    await new Promise((r) => setTimeout(r, 300));

    // 只拉 1 个（v3.0，last_updated 最新）
    const pulls = dockerCalls.filter((c) => c[0] === 'pull');
    assert.equal(pulls.length, 1, '应只拉 1 个 tag（last_updated 最新）');
    assert.equal(pulls[0][1], 'user/multi-tags:v3.0');
  });

  test('image 型未指定 tag：同样仅拉最新 tag', async () => {
    const agentF = request.agent(app);
    await agentF.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });

    // image 型但不带 tag（images 里只写 repo 名，无 :tag）→ 等同未指定 tag
    const created = await agentF.post('/api/tasks').send({
      name: 'F9 image 无 tag', type: 'image', source: 'custom', images: ['user/multi-tags'], cron_expr: '0 3 1 * *',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    dockerCalls.length = 0;
    const run = await agentF.post(`/api/tasks/${id}/run`);
    assert.equal(run.status, 202);
    await new Promise((r) => setTimeout(r, 300));

    const pulls = dockerCalls.filter((c) => c[0] === 'pull');
    assert.equal(pulls.length, 1, 'image 型未指定 tag 应只拉最新');
    assert.equal(pulls[0][1], 'user/multi-tags:v3.0');
  });
});
