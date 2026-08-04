/**
 * executor.js — 调度与保活执行（模块 C）
 *
 * - 全局串行 FIFO 队列 + 任务级单飞锁（cron 与手动触发重叠时后到跳过）
 * - 空间预检：fs.statfs 宿主挂载点（/host:ro），available ≥ 估算×headroom，不足跳过 + 告警
 * - 任务内受控并发：可用空间 ≥ 估算×2 → 并发 3，否则逐个（默认 1）
 * - 逐镜像「列 tag → pull → 成功后立即 rmi」，pull/rmi 失败指数退避重试
 * - 清理兜底：prune_enabled 时 prune dangling
 * - 每次执行写 execution_logs + execution_log_items，完成后触发三通道通知
 */

import fs from 'node:fs';
import db from '../db/index.js';
import config from '../config.js';
import * as settings from './settings.js';
import * as tasks from './tasks.js';
import * as notify from './notify.js';

export function createExecutor({ docker, dockerhub, sleep = notify.sleep } = {}) {
  const queue = [];
  let processing = false;
  let runningTaskId = null;
  let runningCleanup = false;

  /* ---------------- 队列 ---------------- */

  function enqueue(task, trigger) {
    if (task && runningTaskId === task.id) {
      // 单飞：同一任务已在执行，跳过
      return { queued: false, reason: '任务正在执行中，本次触发跳过' };
    }
    if (trigger === 'cleanup' && runningCleanup) {
      return { queued: false, reason: '清理任务正在执行中' };
    }
    queue.push({ task: task || null, trigger });
    processNext();
    return { queued: true };
  }

  async function processNext() {
    if (processing) return;
    const job = queue.shift();
    if (!job) return;
    processing = true;
    try {
      if (job.trigger === 'cleanup') {
        runningCleanup = true;
        await runCleanupJob();
        runningCleanup = false;
      } else {
        runningTaskId = job.task.id;
        await executeTask(job.task, job.trigger);
        runningTaskId = null;
      }
    } catch (err) {
      console.error('[executor] 任务执行异常：', err.message);
    } finally {
      processing = false;
      processNext();
    }
  }

  /* ---------------- 空间预检 ---------------- */

  function hostAvailableBytes() {
    try {
      const st = fs.statfsSync(config.hostMount);
      return st.bavail * st.bsize;
    } catch {
      return null; // 无法读取（非容器环境）→ 跳过预检放行
    }
  }

  /* ---------------- 拉取目标 ---------------- */

  async function buildPullTargets(task) {
    const targets = [];
    const failedMeta = [];
    const maxTags = settings.getInt('max_tags_per_repo', config.maxTagsPerRepo);
    const images = task.images || [];
    for (const img of images) {
      if (task.type === 'username' || !img.tag) {
        // 用户名任务 / 未指定 tag：列仓库全部 tag（取前 maxTags）
        try {
          const tags = await dockerhub.listTags(img.repo, { limit: maxTags });
          if (tags.length === 0) {
            targets.push({ repo: img.repo, tag: 'latest' });
          } else {
            for (const t of tags) targets.push({ repo: img.repo, tag: t.name });
          }
        } catch (err) {
          // 列 tag 失败：降级拉 latest 并记录
          targets.push({ repo: img.repo, tag: 'latest' });
          failedMeta.push({ repo: img.repo, reason: `列 tag 失败，降级 latest：${err.message}` });
        }
      } else {
        targets.push({ repo: img.repo, tag: img.tag });
      }
    }
    return { targets, failedMeta };
  }

  function refOf(t) {
    return t.tag ? `${t.repo}:${t.tag}` : t.repo;
  }

  /* ---------------- 单镜像 pull → rmi ---------------- */

  async function pullWithRetry(t, retries = config.pullRetries) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await docker.pull(refOf(t));
        return { ok: true, retries: attempt };
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(config.pullRetryBaseMs * 3 ** attempt);
      }
    }
    return { ok: false, error: lastErr?.message || 'pull 失败', retries };
  }

  async function rmiWithRetry(t, retries = config.pullRetries) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await docker.remove(refOf(t));
        return { ok: true, retries: attempt };
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(config.pullRetryBaseMs * 3 ** attempt);
      }
    }
    return { ok: false, error: lastErr?.message || 'rmi 失败', retries };
  }

  /** 受控并发处理（默认并发 1；空间充足自动升 3） */
  async function processWithConcurrency(items, concurrency, handler) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await handler(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /* ---------------- 单任务执行 ---------------- */

  async function executeTaskInner(task, trigger, logId) {
    const estimated = task.estimated_size || 0;
    const available = hostAvailableBytes();
    const spaceCheck = {
      estimated_size: estimated,
      available_bytes: available,
      required: estimated * config.spaceHeadroom,
      passed: available === null || estimated === 0 || available >= estimated * config.spaceHeadroom,
    };

    if (!spaceCheck.passed) {
      // 空间不足：跳过 + 系统告警
      db()
        .prepare(
          `UPDATE execution_logs SET status = 'skipped', space_check = ?, finished_at = ?,
             duration_ms = 0, total_images = 0 WHERE id = ?`
        )
        .run(JSON.stringify(spaceCheck), new Date().toISOString(), logId);
      tasks.setLastRun(task.id, new Date().toISOString(), 'skipped');
      const logRow = getLog(logId);
      notify.systemAlert(
        '空间不足，任务已跳过',
        `任务「${task.name}」估算容量 ${fmtSize(estimated)}，可用空间 ${fmtSize(available || 0)}（需 ${fmtSize(estimated * config.spaceHeadroom)}）`
      );
      notify.taskCompleted({ ...logRow, task_name: task.name });
      return logRow;
    }

    // 构建拉取目标
    const { targets, failedMeta } = await buildPullTargets(task);
    const concurrency = available !== null && estimated > 0 && available >= estimated * 2 ? 3 : 1;

    const itemResults = await processWithConcurrency(targets, concurrency, async (t) => {
      const start = Date.now();
      const pullRes = await pullWithRetry(t);
      const pullMs = Date.now() - start;
      if (pullRes.ok) {
        const rmiStart = Date.now();
        const rmiRes = await rmiWithRetry(t);
        const rmiMs = Date.now() - rmiStart;
        insertLogItem(logId, t.repo, t.tag, 'pull', pullRes.ok ? 'success' : 'failed', null, pullRes.retries, pullMs);
        insertLogItem(logId, t.repo, t.tag, 'rmi', rmiRes.ok ? 'success' : 'failed', rmiRes.ok ? null : rmiRes.error, rmiRes.retries, rmiMs);
        return { ok: rmiRes.ok, error: rmiRes.error };
      }
      insertLogItem(logId, t.repo, t.tag, 'pull', 'failed', pullRes.error, pullRes.retries, pullMs);
      return { ok: false, error: pullRes.error };
    });

    // 汇总
    const successCount = itemResults.filter((r) => r.ok).length;
    const failCount = itemResults.length - successCount;
    const status = failCount === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed';

    // 清理兜底
    let cleanupResult = null;
    let pruned = false;
    if (failCount > 0 && settings.getBool('prune_enabled')) {
      try {
        const r = await docker.pruneDangling();
        pruned = true;
        cleanupResult = {
          rmi_retries: config.pullRetries,
          pruned,
          prune_result: `删除 ${r?.ImagesDeleted?.length ?? 0} 个 dangling 镜像，释放 ${fmtSize(r?.SpaceReclaimed || 0)}`,
        };
      } catch (err) {
        cleanupResult = { rmi_retries: config.pullRetries, pruned: false, prune_result: `prune 失败：${err.message}` };
      }
    } else if (failCount === 0) {
      cleanupResult = { rmi_retries: 0, pruned: false, prune_result: null };
    } else {
      cleanupResult = { rmi_retries: config.pullRetries, pruned: false, prune_result: 'prune 未开启' };
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(db().prepare('SELECT started_at FROM execution_logs WHERE id = ?').get(logId).started_at).getTime();
    db()
      .prepare(
        `UPDATE execution_logs SET status = ?, space_check = ?, finished_at = ?, duration_ms = ?,
           total_images = ?, success_count = ?, fail_count = ?, cleanup_result = ?
         WHERE id = ?`
      )
      .run(status, JSON.stringify(spaceCheck), finishedAt, durationMs, targets.length, successCount, failCount, cleanupResult ? JSON.stringify(cleanupResult) : null, logId);
    tasks.setLastRun(task.id, finishedAt, status);

    const logRow = getLog(logId);
    notify.taskCompleted({ ...logRow, task_name: task.name });
    return logRow;
  }

  /* ---------------- 单任务执行（入口：初始 running + 异常兜底） ---------------- */

  async function executeTask(task, trigger) {
    const startedAt = new Date().toISOString();
    const logId = db()
      .prepare(
        `INSERT INTO execution_logs (task_id, trigger, status, started_at, total_images)
         VALUES (?, ?, 'running', ?, 0)`
      )
      .run(task.id, trigger, startedAt).lastInsertRowid;
    try {
      return await executeTaskInner(task, trigger, logId);
    } catch (err) {
      // 执行异常：日志标记失败并记录原因（修复：原初始 'failed' 导致执行中/异常中断均显示失败且无原因）
      db()
        .prepare(
          `UPDATE execution_logs SET status = 'failed', finished_at = ?, duration_ms = ?,
             cleanup_result = ? WHERE id = ?`
        )
        .run(new Date().toISOString(), Date.now() - new Date(startedAt).getTime(), JSON.stringify({ error: err?.message || String(err) }), logId);
      try { tasks.setLastRun(task.id, new Date().toISOString(), 'failed'); } catch { /* 尽力而为 */ }
      throw err;
    }
  }

  /* ---------------- 立即执行清理 ---------------- */

  async function runCleanupJob() {
    const startedAt = new Date().toISOString();
    const logId = db()
      .prepare(
        `INSERT INTO execution_logs (task_id, trigger, status, started_at, total_images)
         VALUES (NULL, 'cleanup', 'failed', ?, 0)`
      )
      .run(startedAt).lastInsertRowid;
    const enabled = settings.getBool('prune_enabled');
    if (!enabled) {
      db()
        .prepare(
          `UPDATE execution_logs SET status = 'skipped', finished_at = ?, duration_ms = 0 WHERE id = ?`
        )
        .run(new Date().toISOString(), logId);
      return getLog(logId);
    }
    let cleanupResult;
    try {
      const r = await docker.pruneDangling();
      cleanupResult = {
        rmi_retries: 0,
        pruned: true,
        prune_result: `删除 ${r?.ImagesDeleted?.length ?? 0} 个 dangling 镜像，释放 ${fmtSize(r?.SpaceReclaimed || 0)}`,
      };
    } catch (err) {
      cleanupResult = { rmi_retries: 0, pruned: false, prune_result: `prune 失败：${err.message}` };
    }
    const finishedAt = new Date().toISOString();
    db()
      .prepare(
        `UPDATE execution_logs SET status = 'success', finished_at = ?, duration_ms = ?,
           cleanup_result = ? WHERE id = ?`
      )
      .run(finishedAt, Date.now() - new Date(startedAt).getTime(), JSON.stringify(cleanupResult), logId);
    const logRow = getLog(logId);
    notify.insertNotification({
      type: 'system',
      title: '清理执行完成',
      content: { title: '清理执行完成', detail: cleanupResult.prune_result, created_at: finishedAt },
    });
    return logRow;
  }

  /* ---------------- 内部工具 ---------------- */

  function insertLogItem(logId, repo, tag, action, status, message, retries, durationMs) {
    db()
      .prepare(
        `INSERT INTO execution_log_items (log_id, repo, tag, action, status, message, retries, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(logId, repo, tag ?? null, action, status, message ?? null, retries ?? 0, durationMs ?? null);
  }

  function getLog(id) {
    const row = db().prepare('SELECT * FROM execution_logs WHERE id = ?').get(id);
    if (!row) return null;
    if (row.space_check) {
      try { row.space_check = JSON.parse(row.space_check); } catch { /* keep raw */ }
    }
    if (row.cleanup_result) {
      try { row.cleanup_result = JSON.parse(row.cleanup_result); } catch { /* keep raw */ }
    }
    return row;
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes) || bytes === null || bytes === undefined) return '未知';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  return {
    enqueue,
    getLog,
    fmtSize,
    // 测试辅助
    _hostAvailableBytes: hostAvailableBytes,
    _queueLength: () => queue.length,
  };
}

export default createExecutor;
