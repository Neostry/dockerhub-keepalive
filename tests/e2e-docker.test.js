/**
 * e2e-docker.test.js — TASK-12 真实 Docker 全链路测试（TC-68）
 *
 * 覆盖 测试计划_Test_Plan.md TC-68「扫描→创建→执行→删除→通知」核心闭环：
 * - 真实 dockerode（Windows npipe / Unix socket 自动探测）操作宿主 Docker
 * - 创建 image 型任务（library/busybox:latest）→ 立即执行 → 真实 pull → 真实 rmi
 * - 断言执行日志 success、宿主镜像已删除（rmi 生效）、站内信生成
 *
 * 环境要求：Docker Engine 可用 + Docker Hub 可达；不可用时测试 skip 并记录。
 * 环境清洁：执行结束无论成败均兜底删除 busybox 镜像与临时 DB 文件。
 */

process.env.APP_SECRET_KEY = 'e2e-secret-key-0123456789abcdef';
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

// 临时 DB（真实文件，验证持久化语义；测完删除）
const tmpDb = path.join(os.tmpdir(), `dockerhub-qa-e2e-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.DB_PATH = tmpDb;

const { createApp } = await import('../src/app.js');
const db = (await import('../src/db/index.js')).default;

const IMAGE = 'library/busybox:latest';
const REPO = 'library/busybox';
const TAG = 'latest';

/* ---------------- Docker 探测（Windows npipe / Unix socket） ---------------- */

async function probeDocker() {
  const candidates = [];
  // dockerode 默认（Windows 自动 npipe；Linux 默认 socket）
  candidates.push(new Docker());
  if (process.platform === 'win32') {
    candidates.push(new Docker({ protocol: 'npipe', socketPath: '//./pipe/docker_engine' }));
  } else {
    candidates.push(new Docker({ socketPath: '/var/run/docker.sock' }));
  }
  for (const d of candidates) {
    try {
      const info = await d.info();
      if (info?.ServerVersion) return d;
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}

let app, agent, docker;

before(async () => {
  docker = await probeDocker();
  if (!docker) {
    console.log('[e2e] Docker Engine 不可用，TC-68 将被跳过（blocked）');
    return;
  }
  // 真实 docker 客户端封装（与 createDockerClient 同形状）
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
  // 兜底删除测试镜像（防残留）
  if (docker) {
    docker.getImage(IMAGE).remove({ force: true }).catch(() => {});
  }
  // 删除临时 DB 文件（含 WAL/SHM）
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(tmpDb))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
  } catch { /* ignore */ }
});

async function waitForLog(predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await agent.get('/api/logs?page_size=5');
    const hit = logs.body.items.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test('TC-68 真实 Docker 全链路：扫描→创建→pull→rmi→日志→通知', async (t) => {
  if (!docker) return t.skip('Docker Engine 不可用（blocked：TC-68 未执行）');

  // 1) 创建 image 型任务（真实 Docker Hub 拉取源）
  const created = await agent.post('/api/tasks').send({
    name: 'e2e 真实链路',
    type: 'image',
    images: [IMAGE],
    cron_expr: '0 3 1 * *',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // 2) 立即执行（P1/F9a）
  const run = await agent.post(`/api/tasks/${created.body.id}/run`);
  assert.equal(run.status, 202, JSON.stringify(run.body));

  // 3) 轮询等待执行完成（真实 pull 需要网络时间）
  const log = await waitForLog((l) => l.trigger === 'manual' && l.finished_at !== null);
  assert.ok(log, '应在超时内产生执行日志');

  // 4) 断言执行成功
  assert.equal(log.status, 'success', JSON.stringify(log));
  assert.equal(log.total_images, 1);
  assert.equal(log.success_count, 1);
  assert.equal(log.fail_count, 0);
  assert.ok(log.duration_ms >= 0);

  // 5) 断言 rmi 生效：宿主 Docker 不再存在该镜像（pull 后已删除）
  let exists = true;
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    exists = false;
  }
  assert.equal(exists, false, '执行完成后镜像应从宿主 Docker 删除（rmi 生效）');

  // 6) 日志明细：pull + rmi 两条 success
  const detail = await agent.get(`/api/logs/${log.id}`);
  assert.equal(detail.body.items.length, 2);
  const pulls = detail.body.items.filter((i) => i.action === 'pull');
  const rmis = detail.body.items.filter((i) => i.action === 'rmi');
  assert.equal(pulls.length, 1);
  assert.equal(rmis.length, 1);
  assert.equal(pulls[0].status, 'success');
  assert.equal(rmis[0].status, 'success');
  assert.equal(pulls[0].repo, REPO);
  assert.equal(pulls[0].tag, TAG);

  // 7) 站内信必达
  const notis = await agent.get('/api/notifications?unread_only=1');
  assert.ok(notis.body.items.some((n) => n.type === 'task'), '应有任务站内信');
});
