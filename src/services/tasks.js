/**
 * tasks.js — 任务配置服务层（模块 B）
 *
 * - 任务 CRUD + task_images 镜像快照维护
 * - cron 语法校验（croner 5 段标准格式）
 * - 任务变更通过事件回调通知模块 C 重建调度注册表（避免模块间直接依赖）
 */

import { Cron } from 'croner';
import db from '../db/index.js';

const REPO_RE = /^[a-z0-9]+([._-][a-z0-9]+)*\/[a-z0-9]+([._-][a-z0-9]+)*(:[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;

/** cron 语法校验：合法返回 null，非法返回错误信息 */
export function validateCron(expr) {
  try {
    new Cron(expr);
    return null;
  } catch {
    return `非法 cron 表达式，示例：0 3 1 * *（每月 1 日 03:00）`;
  }
}

/** 单条镜像输入校验：'ns/repo[:tag]' */
export function validateImageLine(line) {
  const s = String(line || '').trim();
  if (!s) return { ok: false, reason: '空行' };
  if (!REPO_RE.test(s)) {
    return { ok: false, reason: '格式应为 namespace/repo[:tag]（小写字母/数字/._-）' };
  }
  return { ok: true, value: s };
}

/** 解析 'ns/repo:tag' → {repo, tag} */
export function parseImageLine(line) {
  const idx = line.lastIndexOf(':');
  // 注意 tag 中允许 . _ -，repo 中允许 . _ - /；冒号仅在 tag 分隔
  if (idx > 0 && !line.slice(idx + 1).includes('/')) {
    return { repo: line.slice(0, idx), tag: line.slice(idx + 1) };
  }
  return { repo: line, tag: null };
}

function listImagesOfTask(taskId) {
  return db()
    .prepare(
      `SELECT id, repo, tag, latest_tag, description, storage_size, last_updated, display_order
       FROM task_images WHERE task_id = ? ORDER BY display_order ASC, id ASC`
    )
    .all(taskId);
}

function insertImages(taskId, images) {
  const ins = db().prepare(
    `INSERT INTO task_images (task_id, repo, tag, latest_tag, description, storage_size, last_updated, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  images.forEach((img, i) => {
    ins.run(
      taskId,
      img.repo,
      img.tag ?? null,
      img.latest_tag ?? null,
      img.description ?? null,
      typeof img.storage_size === 'number' ? img.storage_size : null,
      img.last_updated ?? null,
      i
    );
  });
}

/**
 * 解析 tasks.source：username 型 = 用户名（必填）；image 型 = 显式 source 优先，否则镜像列表拼接
 * （架构 4.2：source = 用户名或镜像列表；schema NOT NULL 保持）
 */
function resolveSource(input, images) {
  if (input.type === 'username') {
    return input.source ?? null;
  }
  if (input.source !== undefined && input.source !== null) {
    return String(input.source);
  }
  if (Array.isArray(input.images)) {
    return input.images.join('\n');
  }
  return null;
}

/**
 * 创建任务
 * @param {{name,type,source,cron_expr,enabled,selected_repos?,images?}} input
 */
export function createTask(input, { onChanged } = {}) {
  const cronErr = validateCron(input.cron_expr);
  if (cronErr) throw new Error(cronErr);
  const now = new Date().toISOString();
  const tx = db().transaction(() => {
    const source = resolveSource(input, null);
    if (!source) throw Object.assign(new Error('缺少 source（用户名或镜像列表）'), { status: 400 });
    const info = db()
      .prepare(
        `INSERT INTO tasks (name, type, source, cron_expr, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.name, input.type, source, input.cron_expr, input.enabled ?? 1, now, now);
    const taskId = info.lastInsertRowid;
    let images = [];
    if (input.type === 'username') {
      images = (input.selected_repos || []).map((r) => ({
        repo: r.repo,
        latest_tag: r.latest_tag ?? null,
        description: r.description ?? null,
        storage_size: r.storage_size ?? null,
        last_updated: r.last_updated ?? null,
      }));
    } else {
      images = (input.images || []).map((line) => {
        const { repo, tag } = parseImageLine(line);
        return { repo, tag };
      });
    }
    insertImages(taskId, images);
    return taskId;
  });
  const taskId = tx();
  onChanged?.();
  return Number(taskId);
}

export function getTask(id) {
  const task = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  const images = listImagesOfTask(id);
  const estimated_size = images.reduce((s, r) => s + (r.storage_size || 0), 0);
  return { ...task, enabled: !!task.enabled, images, estimated_size };
}

export function listTasks() {
  const rows = db()
    .prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC')
    .all();
  return rows.map((t) => {
    const images = listImagesOfTask(t.id);
    return {
      id: t.id,
      name: t.name,
      type: t.type,
      source: t.source,
      cron_expr: t.cron_expr,
      enabled: !!t.enabled,
      image_count: images.length,
      estimated_size: images.reduce((s, r) => s + (r.storage_size || 0), 0),
      last_run_at: t.last_run_at,
      last_run_status: t.last_run_status,
      created_at: t.created_at,
    };
  });
}

/** 更新任务（部分字段）：名称/cron/启用/镜像列表（images 或 selected_repos 提供则全量替换快照） */
export function updateTask(id, input, { onChanged } = {}) {
  const task = getTask(id);
  if (!task) throw Object.assign(new Error('任务不存在'), { code: 'NOT_FOUND' });
  if (input.cron_expr !== undefined) {
    const cronErr = validateCron(input.cron_expr);
    if (cronErr) throw new Error(cronErr);
  }
  const now = new Date().toISOString();
  const tx = db().transaction(() => {
    // 类型以任务现有值为准（PUT 契约「可部分」，可能不传 type）
    const taskType = input.type ?? task.type;
    // 先计算镜像列表（若变更），用于 source 同步
    const hasImages =
      taskType === 'username' ? Array.isArray(input.selected_repos) : Array.isArray(input.images);
    let images = null;
    if (hasImages) {
      if (taskType === 'username') {
        images = (input.selected_repos || []).map((r) => ({
          repo: r.repo,
          latest_tag: r.latest_tag ?? null,
          description: r.description ?? null,
          storage_size: r.storage_size ?? null,
          last_updated: r.last_updated ?? null,
        }));
      } else {
        images = (input.images || []).map((line) => {
          const { repo, tag } = parseImageLine(line);
          return { repo, tag };
        });
      }
    }
    // source：显式提供则更新；image 型仅更新镜像列表时自动同步拼接
    let newSource = null;
    if (input.source !== undefined && input.source !== null) {
      newSource = String(input.source);
    } else if (hasImages && taskType === 'image') {
      newSource = (input.images || []).join('\n');
    }
    db()
      .prepare(
        `UPDATE tasks SET
           name = COALESCE(?, name),
           cron_expr = COALESCE(?, cron_expr),
           enabled = COALESCE(?, enabled),
           source = COALESCE(?, source),
           updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name ?? null,
        input.cron_expr ?? null,
        input.enabled === undefined ? null : input.enabled ? 1 : 0,
        newSource,
        now,
        id
      );
    if (hasImages) {
      db().prepare('DELETE FROM task_images WHERE task_id = ?').run(id);
      insertImages(id, images);
    }
  });
  tx();
  onChanged?.();
  return getTask(id);
}

export function deleteTask(id, { onChanged } = {}) {
  const info = db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (info.changes === 0) throw Object.assign(new Error('任务不存在'), { code: 'NOT_FOUND' });
  onChanged?.();
}

export function setLastRun(id, at, status) {
  db()
    .prepare('UPDATE tasks SET last_run_at = ?, last_run_status = ?, updated_at = ? WHERE id = ?')
    .run(at ?? null, status ?? null, new Date().toISOString(), id);
}
