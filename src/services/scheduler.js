/**
 * scheduler.js — 调度注册表（模块 C）
 *
 * - 任务表驱动：启动与任务变更时重建 croner 实例（timezone = TZ，默认 UTC）
 * - 每次触发将任务压入执行队列（executor.enqueue），重叠由单飞锁处理
 * - 可选「定时重启容器」兜底（settings.restart_cron）
 * - nextRunAt()：临时实例计算下次触发时间（列表展示用，不注册）
 */

import { Cron } from 'croner';
import db from '../db/index.js';
import config from '../config.js';
import * as settings from './settings.js';
import * as tasks from './tasks.js';

export function createScheduler({ executor, docker } = {}) {
  const registry = new Map(); // taskId -> Cron

  /** 计算 cron 下次触发时间（不注册，仅查询） */
  function nextRunAt(cronExpr, tz = config.tz) {
    try {
      const c = new Cron(cronExpr, { timezone: tz, paused: true });
      return c.nextRun() ? new Date(c.nextRun()).toISOString() : null;
    } catch {
      return null;
    }
  }

  function clearRegistry() {
    for (const [, cron] of registry) {
      try { cron.stop(); } catch { /* ignore */ }
    }
    registry.clear();
  }

  /** 以任务表为准重建全部调度（任务增删改/启停后调用） */
  function rebuildRegistry() {
    clearRegistry();
    const rows = db()
      .prepare(`SELECT * FROM tasks WHERE enabled = 1`)
      .all();
    for (const t of rows) {
      try {
        const cron = new Cron(t.cron_expr, { timezone: config.tz }, () => {
          const task = tasks.getTask(t.id);
          if (task) executor.enqueue(task, 'cron');
        });
        registry.set(t.id, cron);
      } catch (err) {
        console.error(`[scheduler] 任务 #${t.id} cron 注册失败：`, err.message);
      }
    }
    scheduleRestart();
  }

  /** 定时重启本容器（可选兜底）；restart_cron 为空则关闭 */
  function scheduleRestart() {
    const expr = settings.get('restart_cron', '');
    if (!expr) return;
    try {
      new Cron(expr, { timezone: config.tz }, async () => {
        try {
          await docker.restartContainer();
        } catch (err) {
          console.error('[scheduler] 定时重启失败：', err.message);
        }
      });
    } catch (err) {
      console.error('[scheduler] restart_cron 注册失败：', err.message);
    }
  }

  return { nextRunAt, rebuildRegistry, registry };
}

export default createScheduler;
