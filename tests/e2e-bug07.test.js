/**
 * e2e-bug07.test.js — BUG-07 终修（方案 G）真实 Docker 环境验证
 *
 * 场景复现（真实 Docker）：容器占用 library/busybox:latest → 触发保活任务
 * （真实 pull 刷新 Hub 活跃度 → rmi 触发真实 409 conflict）→ 断言：
 * - 任务 status = success（409 不算失败）
 * - rmi item：status=success + message「跳过 rmi：镜像被容器占用（pull 已刷新 Hub 活跃度）」
 * - 无 409 报错 / 无 rmi failed / fail_count=0
 *
 * 环境要求：Docker Engine 可用 + Docker Hub 可达；否则 skip。
 * 环境清洁：测试容器强制删除 + busybox 镜像兜底 rmi + 临时 DB 清理。
 */

process.env.APP_SECRET_KEY = 'e2e-bug07-secret-0123456789abcdef';
process.env.SERVE_STATIC = '0';
process.env.PULL_RETRIES = '2';
process.env.PULL_RETRY_BASE_MS = '500';
process.env.NOTIFY_RETRIES = '0';
process.env.TRUST_PROXY = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import request from 'supertest';
import Docker from 'dockerode';

const { createDockerHubClient } = await import('../src/services/dockerhub.js');

const tmpDb = path.join(os.tmpdir(), `dockerhub-qa-bug07-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = tmpDb;

const { createApp } = await import('../src/app.js');

const IMAGE = 'library/busybox:latest';
const REPO = 'library/busybox';
const TAG = 'latest';
const CONTAINER_NAME = `bug07-qa-occupier-${crypto.randomBytes(4).toString('hex')}`;
const SKIP_MSG = '跳过 rmi：镜像被容器占用（pull 已刷新 Hub 活跃度）';

/* ---------------- Docker 探测 ---------------- */

async function probeDocker() {
  const candidates = [new Docker()];
  if (process.platform === 'win32') {
    candidates.push(new Docker({ protocol: 'npipe', socketPath: '//./pipe/docker_engine' }));
  } else {
    candidates.push(new Docker({ socketPath: '/var/run/docker.sock' }));
  }
  for (const d of candidates) {
    try {
      const info = await d.info();
      if (info?.ServerVersion) return d;
    } catch { /* next */ }
  }
  return null;
}

let docker, app, agent, occupierId = null;

before(async () => {
  docker = await probeDocker();
  if (!docker) {
    console.log('[e2e-bug07] Docker Engine 不可用，验证将被跳过（blocked）');
    return;
  }
  // 1) 确保 busybox:latest 已拉取（供占用容器使用）
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    const stream = await docker.pull(IMAGE);
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      stream.resume();
    });
  }
  // 2) 启动占用容器（模拟用户容器引用该镜像）
  const container = await docker.createContainer({
    Image: IMAGE,
    name: CONTAINER_NAME,
    Cmd: ['sleep', '3600'],
  });
  await container.start();
  occupierId = container.id;

  // 3) 真实 docker 客户端封装（rmi 抛真实 409 错误）
  const realDocker = {
    async pull(ref) {
      const stream = await docker.pull(ref);
      await new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
        stream.resume();
      });
      await docker.getImage(ref).inspect();
    },
    async remove(ref) {
      await docker.getImage(ref).remove({ force: false });
    },
    async pruneDangling() {
      return docker.pruneImages({ filters: { dangling: ['true'] } });
    },
    async restartContainer() {
      throw new Error('e2e 不执行容器重启');
    },
  };
  const built = createApp({ docker: realDocker, dockerhub: createDockerHubClient() });
  app = built.app;
  built.scheduler.rebuildRegistry();

  await request(app).post('/api/setup').send({ username: 'admin', password: 'admin123' });
  agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
});

after(() => {
  // 环境清洁：强制删除占用容器 + busybox 兜底 rmi + 临时 DB
  if (docker) {
    if (occupierId) docker.getContainer(occupierId).remove({ force: true }).catch(() => {});
    docker.getImage(IMAGE).remove({ force: true }).catch(() => {});
  }
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(tmpDb))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
  } catch { /* ignore */ }
});

async function waitForLog(predicate, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await agent.get('/api/logs?page_size=5');
    const hit = logs.body.items.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test('BUG-07 真实 Docker：容器占用镜像 → 保活任务 success + rmi 跳过（无 409 报错）', async (t) => {
  if (!docker) return t.skip('Docker Engine 不可用（blocked）');

  // 创建保活任务并立即执行
  const created = await agent.post('/api/tasks').send({
    name: 'bug07 真实占用',
    type: 'image',
    images: [IMAGE],
    cron_expr: '0 3 1 * *',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await agent.post(`/api/tasks/${created.body.id}/run`);
  assert.equal(run.status, 202, JSON.stringify(run.body));

  // 轮询等待执行完成（真实 pull 需要网络时间）
  const log = await waitForLog((l) => l.trigger === 'manual' && l.finished_at !== null);
  assert.ok(log, '应在超时内产生执行日志');

  // 断言 1：任务整体 success（409 不算失败）
  assert.equal(log.status, 'success', JSON.stringify(log));
  assert.equal(log.total_images, 1);
  assert.equal(log.success_count, 1);
  assert.equal(log.fail_count, 0, 'fail_count 应为 0（409 被识别为 skipped 不算失败）');

  // 断言 2：rmi item 为 success + 跳过标注 message
  const detail = await agent.get(`/api/logs/${log.id}`);
  const pullItem = detail.body.items.find((it) => it.action === 'pull');
  const rmiItem = detail.body.items.find((it) => it.action === 'rmi');
  assert.ok(pullItem, '应有 pull item');
  assert.equal(pullItem.status, 'success');
  assert.equal(pullItem.repo, REPO);
  assert.equal(pullItem.tag, TAG);
  assert.ok(rmiItem, '应有 rmi item');
  assert.equal(rmiItem.status, 'success', 'rmi item 应为 success（跳过）');
  assert.equal(rmiItem.message, SKIP_MSG, `message 应为「${SKIP_MSG}」`);

  // 断言 3：无 rmi failed / 无 409 错误
  const failedItems = detail.body.items.filter((it) => it.status === 'failed');
  assert.equal(failedItems.length, 0, '不应有 failed item（409 不算失败）');
  const raw = JSON.stringify(detail.body.items);
  assert.ok(!raw.includes('409'), '日志不应含 409 错误');

  // 断言 4：宿主镜像仍存在（被容器占用，本就无法删除——符合预期保留）
  let exists = true;
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    exists = false;
  }
  assert.equal(exists, true, '被占用的镜像应保留在宿主（跳过 rmi 正确）');
});
