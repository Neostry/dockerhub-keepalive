/**
 * auth.js — 账号与安全服务层（模块 A）
 *
 * - 密码：Argon2id（m=19456, t=2, p=1，OWASP 推荐）
 * - 2FA：otplib TOTP（RFC 6238）；密钥 AES-256-GCM 加密落库（AAD='totp'）
 * - 会话：32B 随机 token；Cookie 存原始值；库中仅存 SHA-256(token)；过期/吊销校验
 * - 限速：按 IP 维度持久化于 login_attempts；指数退避 1/2/4/8/16s；达阈值锁定
 * - 登录保护开关：settings.login_protection_enabled（F5a）
 */

import argon2 from 'argon2';
import { generateSecret, verifySync, generateURI } from 'otplib';
import crypto from 'node:crypto';
import db from '../db/index.js';
import config from '../config.js';
import * as settings from './settings.js';
import { encrypt, decrypt } from './crypto.js';

export const ARGON2_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** 密码强度校验：≥8 位且同时含字母与数字 */
export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    return { ok: false, reason: '密码长度至少 8 位' };
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return { ok: false, reason: '密码须同时包含字母与数字' };
  }
  return { ok: true };
}

/** 用户名合法性：1-64 位可见字符，禁止控制字符 */
export function validateUsername(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
    return { ok: false, reason: '用户名长度须为 1~64 位' };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, reason: '用户名含非法字符' };
  }
  return { ok: true };
}

export function isInitialized() {
  return settings.getBool('setup_completed');
}

/** 登录保护开关（F5a）：默认开启 */
export function loginProtectionEnabled() {
  return settings.getBool('login_protection_enabled');
}

export function getCurrentUser() {
  return db()
    .prepare('SELECT id, username, password_hash, totp_secret_enc, totp_enabled FROM users WHERE id = 1')
    .get();
}

export function getPasswordHash() {
  return getCurrentUser()?.password_hash ?? null;
}

/* ---------------- 2FA ---------------- */

/** 生成 TOTP secret + otpauth URI（不落库，由 enable 校验后加密入库） */
export function generateTotp(secret) {
  const s = secret || generateSecret();
  const username = getCurrentUser()?.username || 'admin';
  const uri = generateURI({ issuer: 'DockerHub KeepAlive', label: username, secret: s });
  return { secret: s, otpauth_uri: uri };
}

function checkTotp(token, secret) {
  try {
    const r = verifySync({ secret, token: String(token).trim() });
    return Boolean(r.valid);
  } catch {
    return false;
  }
}

/** 校验用户当前已启用 2FA 的动态码 */
export function verifyCurrentTotp(token) {
  const u = getCurrentUser();
  if (!u || !u.totp_enabled || !u.totp_secret_enc) return false;
  let secret;
  try {
    secret = decrypt(u.totp_secret_enc, 'totp');
  } catch {
    return false;
  }
  return checkTotp(token, secret);
}

/** 启用 2FA：校验动态码通过后加密落库 */
export function enableTotp(token, secret) {
  if (!checkTotp(token, secret)) return { ok: false, reason: '动态码错误' };
  db()
    .prepare(
      `UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, updated_at = ?
       WHERE id = 1`
    )
    .run(encrypt(secret, 'totp'), new Date().toISOString());
  return { ok: true };
}

/** 关闭 2FA：校验当前动态码或当前密码（async，password 分支需 await） */
export async function disableTotp({ totp, password }) {
  const u = getCurrentUser();
  if (!u || !u.totp_enabled) return { ok: false, reason: '2FA 未启用' };
  let pass = false;
  if (totp && verifyCurrentTotp(totp)) {
    pass = true;
  } else if (password && u.password_hash) {
    try {
      pass = await argon2.verify(u.password_hash, password);
    } catch {
      pass = false;
    }
  }
  if (!pass) return { ok: false, reason: '动态码或密码错误' };
  db()
    .prepare(
      `UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, updated_at = ?
       WHERE id = 1`
    )
    .run(new Date().toISOString());
  return { ok: true };
}

/** 重新生成密钥：校验旧动态码 → 返回新 secret/uri（待 enable 完成切换） */
export function regenerateTotp(totp) {
  if (!verifyCurrentTotp(totp)) return { ok: false, reason: '动态码错误' };
  return { ok: true, ...generateTotp() };
}

/* ---------------- 会话 ---------------- */

export function issueSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const expires = new Date(now + config.sessionTtlDays * 86400_000).toISOString();
  db()
    .prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
    .run(hash, new Date(now).toISOString(), expires);
  return { token, expiresAt: expires };
}

/** 校验会话 token：存在、未吊销、未过期 → 有效 */
export function validateSession(token) {
  if (!token) return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db()
    .prepare('SELECT expires_at, revoked_at FROM sessions WHERE token_hash = ?')
    .get(hash);
  if (!row) return false;
  if (row.revoked_at) return false;
  if (new Date(row.expires_at).getTime() <= Date.now()) return false;
  return true;
}

export function revokeSession(token) {
  if (!token) return;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), hash);
}

/** 吊销全部会话（修改密码/用户名后） */
export function revokeAllSessions() {
  db()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL')
    .run(new Date().toISOString());
}

/** 清理过期会话（启动时调用一次） */
export function cleanupExpiredSessions() {
  db().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

/* ---------------- 登录限速 ---------------- */

/**
 * 登录前检查：锁定中 → 返回拒绝（含剩余秒）；否则放行
 */
export function loginThrottleStatus(ip) {
  const row = db().prepare('SELECT fail_count, locked_until FROM login_attempts WHERE ip = ?').get(ip);
  if (!row) return { allowed: true, failCount: 0 };
  if (row.locked_until && row.locked_until > Date.now()) {
    return {
      allowed: false,
      locked: true,
      retryAfterSec: Math.ceil((row.locked_until - Date.now()) / 1000),
      failCount: row.fail_count,
    };
  }
  if (row.locked_until && row.locked_until <= Date.now()) {
    // 锁定到期：清零
    db().prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
    return { allowed: true, failCount: 0 };
  }
  return { allowed: true, failCount: row.fail_count };
}

/**
 * 登录失败：计数 +1；达阈值 → 锁定；否则按指数退避返回等待秒数
 * @returns {{locked:boolean, retryAfterSec:number}}
 */
export function recordLoginFailure(ip) {
  const now = Date.now();
  const row = db().prepare('SELECT fail_count FROM login_attempts WHERE ip = ?').get(ip);
  const failCount = (row?.fail_count || 0) + 1;
  const lockMs = config.loginLockMinutes * 60_000;
  const lockThreshold = config.loginMaxFailures;
  let locked = false;
  let retryAfterSec = 0;
  if (failCount >= lockThreshold) {
    locked = true;
    db()
      .prepare(
        `INSERT INTO login_attempts (ip, fail_count, locked_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET fail_count = excluded.fail_count,
           locked_until = excluded.locked_until, updated_at = excluded.updated_at`
      )
      .run(ip, failCount, now + lockMs, now);
    retryAfterSec = Math.ceil(lockMs / 1000);
  } else {
    // 指数退避：1s/2s/4s/8s/16s…
    retryAfterSec = Math.min(2 ** (failCount - 1), 60);
    db()
      .prepare(
        `INSERT INTO login_attempts (ip, fail_count, locked_until, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(ip) DO UPDATE SET fail_count = excluded.fail_count,
           locked_until = NULL, updated_at = excluded.updated_at`
      )
      .run(ip, failCount, now);
  }
  return { locked, retryAfterSec, failCount };
}

/** 登录成功：清零该来源失败计数 */
export function clearLoginFailures(ip) {
  db().prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

/* ---------------- 密码校验 ---------------- */

/** 校验用户名 + 密码（+可选 TOTP）。返回统一错误文案，不区分具体错误项 */
export async function verifyCredentials(username, password, totp) {
  const u = getCurrentUser();
  if (!u || u.username !== username) return { ok: false, error: '用户名或密码错误' };
  const hash = u.password_hash ?? getPasswordHash();
  let pwOk = false;
  if (hash) {
    try {
      pwOk = await argon2.verify(hash, password);
    } catch {
      pwOk = false;
    }
  }
  if (!pwOk) return { ok: false, error: '用户名或密码错误' };
  if (u.totp_enabled) {
    if (!totp) return { ok: false, needTotp: true, error: '需要动态码' };
    if (!verifyCurrentTotp(totp)) return { ok: false, error: '用户名或密码错误' };
  }
  return { ok: true, user: u };
}
