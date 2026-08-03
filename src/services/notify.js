/**
 * notify.js — 日志与通知服务层（模块 D）
 *
 * - 站内信：任务执行完成必写 notifications（type=task）；系统告警 type=system
 * - Telegram：fetch sendMessage（HTML）
 * - SMTP：nodemailer（465=TLS / 587=STARTTLS / 25=明文，secure 可显式覆盖）
 * - 三通道互备：独立 try/catch + 重试（默认 3 次指数退避 5s/15s/45s）
 * - 凭证：AES-256-GCM 加密入库（仅写不读），敏感字段留空 = 保持原值
 */

import nodemailer from 'nodemailer';
import db from '../db/index.js';
import config from '../config.js';
import { encrypt, decrypt } from './crypto.js';

/* ---------------- 站内信 ---------------- */

export function insertNotification({ type = 'task', title, content, task_id = null }) {
  const info = db()
    .prepare(
      `INSERT INTO notifications (type, title, content, task_id, read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .run(type, title, JSON.stringify(content), task_id, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/* ---------------- 凭证存取（仅写不读） ---------------- */

function getCredentialRow(channel) {
  return db().prepare('SELECT * FROM credentials WHERE channel = ?').get(channel);
}

function saveCredential(channel, { payload, plain_fields }) {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO credentials (channel, payload, key_version, plain_fields, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         payload = excluded.payload,
         plain_fields = excluded.plain_fields,
         updated_at = excluded.updated_at`
    )
    .run(channel, payload ?? null, JSON.stringify(plain_fields ?? {}), now);
}

function loadPlain(channel) {
  const row = getCredentialRow(channel);
  if (!row) return {};
  try {
    return JSON.parse(row.plain_fields || '{}');
  } catch {
    return {};
  }
}

/** 解密 payload；返回 null 表示未配置或密钥不匹配 */
function loadSecret(channel) {
  const row = getCredentialRow(channel);
  if (!row || !row.payload) return null;
  try {
    return decrypt(row.payload, channel);
  } catch {
    return null; // 主密钥变更等场景：视为未配置，等待重填
  }
}

function encodeSecret(channel, obj) {
  return encrypt(JSON.stringify(obj), channel);
}

/* ---------------- Telegram ---------------- */

export function getTelegramStatus() {
  const plain = loadPlain('telegram');
  const secret = loadSecret('telegram');
  const configured = Boolean(plain.chat_id && secret);
  return { configured, chat_id: plain.chat_id ?? undefined };
}

export function saveTelegram({ chat_id, bot_token }) {
  const plain = loadPlain('telegram');
  const oldSecret = loadSecret('telegram');
  const newChatId = chat_id !== undefined && chat_id !== null && String(chat_id).trim() !== ''
    ? String(chat_id).trim()
    : (plain.chat_id ?? null);
  let secretObj = oldSecret ? JSON.parse(oldSecret) : {};
  if (bot_token !== undefined && bot_token !== null && String(bot_token).trim() !== '') {
    secretObj.bot_token = String(bot_token).trim();
  }
  const payload = secretObj.bot_token ? encodeSecret('telegram', secretObj) : null;
  saveCredential('telegram', { payload, plain_fields: { chat_id: newChatId } });
  return getTelegramStatus();
}

async function sendTelegramOnce({ bot_token, chat_id, text }) {
  const res = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${body.description || '未知错误'}`);
  }
  return body;
}

/** 发送 Telegram 消息（重试）。返回 {ok, error?} */
export async function sendTelegram(text, { retries = config.notifyRetries } = {}) {
  const plain = loadPlain('telegram');
  const secret = loadSecret('telegram');
  if (!plain.chat_id || !secret) return { ok: false, skipped: true };
  const { bot_token } = JSON.parse(secret);
  const fn = () => sendTelegramOnce({ bot_token, chat_id: plain.chat_id, text });
  return retryWithBackoff(fn, retries, 'Telegram');
}

/* ---------------- SMTP ---------------- */

export function getSmtpStatus() {
  const plain = loadPlain('smtp');
  const secret = loadSecret('smtp');
  const configured = Boolean(plain.host && plain.port && plain.to);
  return {
    configured,
    host: plain.host ?? undefined,
    port: plain.port !== undefined ? Number(plain.port) : undefined,
    secure: plain.secure !== undefined ? !!plain.secure : undefined,
    username: plain.username ?? undefined,
    to: plain.to ?? undefined,
  };
}

export function saveSmtp({ host, port, secure, username, password, to }) {
  const plain = loadPlain('smtp');
  const oldSecret = loadSecret('smtp');
  const str = (v) => (v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : undefined);
  const newPlain = {
    host: str(host) ?? plain.host ?? null,
    port: port !== undefined && port !== null && port !== '' ? Number(port) : (plain.port ?? null),
    secure: secure !== undefined ? !!secure : plain.secure ?? null,
    username: str(username) ?? plain.username ?? null,
    to: str(to) ?? plain.to ?? null,
  };
  let secretObj = oldSecret ? JSON.parse(oldSecret) : {};
  if (password !== undefined && password !== null && String(password).trim() !== '') {
    secretObj.password = String(password).trim();
  }
  const payload = secretObj.password ? encodeSecret('smtp', secretObj) : null;
  saveCredential('smtp', { payload, plain_fields: newPlain });
  return getSmtpStatus();
}

function buildTransporter() {
  const plain = loadPlain('smtp');
  const secret = loadSecret('smtp');
  const port = Number(plain.port);
  let secure;
  if (plain.secure !== null && plain.secure !== undefined) {
    secure = !!plain.secure;
  } else {
    secure = port === 465; // 465 默认 TLS；587 STARTTLS；25 明文
  }
  const auth = {};
  if (plain.username) auth.user = plain.username;
  if (secret) {
    const { password } = JSON.parse(secret);
    if (password) auth.pass = password;
  }
  return nodemailer.createTransport({
    host: plain.host,
    port,
    secure,
    auth: Object.keys(auth).length ? auth : undefined,
  });
}

async function sendSmtpOnce({ subject, html }) {
  const plain = loadPlain('smtp');
  if (!plain.host || !plain.port || !plain.to) throw new Error('SMTP 未配置完整');
  const transporter = buildTransporter();
  const toList = String(plain.to)
    .split(/[,;，；\s]+/)
    .filter(Boolean);
  await transporter.sendMail({ from: plain.username || plain.host, to: toList, subject, html });
  transporter.close();
}

/** 发送邮件（重试）。返回 {ok, error?} */
export async function sendSmtp({ subject, html }, { retries = config.notifyRetries } = {}) {
  const plain = loadPlain('smtp');
  if (!plain.host || !plain.port || !plain.to) return { ok: false, skipped: true };
  const fn = () => sendSmtpOnce({ subject, html });
  return retryWithBackoff(fn, retries, 'SMTP');
}

/* ---------------- 通用重试 ---------------- */

export async function retryWithBackoff(fn, retries, label) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const waitMs = config.pullRetryBaseMs * 3 ** attempt; // 5s/15s/45s
        await sleep(waitMs);
      }
    }
  }
  return { ok: false, error: `${label} 发送失败：${lastErr?.message || '未知错误'}` };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 任务汇总报告 ---------------- */

function formatSummary(log) {
  const lines = [
    `🔁 <b>任务执行报告</b>`,
    `任务：${log.task_name || '-'}`,
    `时间：${log.started_at}`,
    `触发：${log.trigger === 'cron' ? '定时' : log.trigger === 'manual' ? '手动' : '清理'}`,
    `状态：${statusText(log.status)}`,
    `镜像数：${log.total_images}（成功 ${log.success_count} / 失败 ${log.fail_count}）`,
  ];
  if (log.cleanup_result) {
    const c = log.cleanup_result;
    lines.push(`清理：rmi 重试 ${c.rmi_retries ?? 0} 次${c.pruned ? `，prune ${c.prune_result ?? ''}` : ''}`);
  }
  return lines.join('\n');
}

function statusText(s) {
  return (
    { success: '✅ 成功', partial: '⚠️ 部分成功', failed: '❌ 失败', skipped: '⏭️ 已跳过' }[s] || s
  );
}

/**
 * 任务执行完成后三通道通知：
 * 站内信同步必达；Telegram/SMTP 异步互备（任一失败不影响其他与任务本身）
 */
export function taskCompleted(log) {
  const content = {
    task_id: log.task_id,
    task_name: log.task_name,
    trigger: log.trigger,
    status: log.status,
    started_at: log.started_at,
    duration_ms: log.duration_ms ?? null,
    total_images: log.total_images,
    success_count: log.success_count,
    fail_count: log.fail_count,
    cleanup_result: log.cleanup_result ?? null,
  };
  insertNotification({ type: 'task', title: `任务执行完成：${log.task_name || '未知任务'}`, content, task_id: log.task_id });
  const text = formatSummary(log);
  // 异步发送，不阻塞执行流
  sendTelegram(text).catch(() => {});
  sendSmtp({ subject: `[镜像保活] ${log.task_name || '任务'} 执行报告`, html: text.replace(/\n/g, '<br>') }).catch(() => {});
}

/** 系统告警（空间不足 / 清理需人工） */
export function systemAlert(title, detail) {
  insertNotification({
    type: 'system',
    title,
    content: { title, detail, created_at: new Date().toISOString() },
  });
  const text = `⚠️ <b>${title}</b>\n${detail}`;
  sendTelegram(text).catch(() => {});
  sendSmtp({ subject: `[镜像保活] ${title}`, html: text.replace(/\n/g, '<br>') }).catch(() => {});
}
