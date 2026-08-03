/**
 * routes/auth.js — 模块 A 账号与安全路由
 *
 * - publicRouter（无需登录）：POST /setup、GET /auth/status、POST /auth/login
 * - protectedRouter（需登录）：logout / password / username / 2fa
 * - 登录失败限速：指数退避 1/2/4/8/16s，达阈值临时锁定（429）
 * - 2FA：TOTP 密钥仅创建时明文返回一次，落库 AES-256-GCM 加密（AAD='totp'）
 */

import { Router } from 'express';
import argon2 from 'argon2';
import { SID_COOKIE, authRequired, clientIp, sessionToken } from '../middleware/auth.js';
import * as auth from '../services/auth.js';
import * as settings from '../services/settings.js';
import db from '../db/index.js';
import config from '../config.js';

export const publicRouter = Router();
export const protectedRouter = Router();

/* 2FA 待启用密钥暂存（内存，单用户场景；服务重启后重新 setup 即可） */
const pendingTotp = new Map(); // 'pending' -> {secret, createdAt}

function setSidCookie(res, token, expiresAt) {
  res.cookie(SID_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: new Date(expiresAt).getTime() - Date.now(),
    secure: config.cookieSecure,
  });
}

/* ================= 公开路由（无需登录） ================= */

/* ---------------- 首次设置 ---------------- */

publicRouter.post('/setup', async (req, res) => {
  if (auth.isInitialized()) {
    return res.status(409).json({ error: '服务已初始化' });
  }
  const { username, password } = req.body || {};
  const nameCheck = auth.validateUsername(username);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.reason });
  const pwCheck = auth.validatePasswordStrength(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });
  const hash = await argon2.hash(password, auth.ARGON2_OPTS);
  const now = new Date().toISOString();
  db()
    .prepare(
      'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    )
    .run(username, hash, now, now);
  settings.set('setup_completed', '1');
  res.status(201).json({ ok: true });
});

/* ---------------- 认证状态 ---------------- */

publicRouter.get('/auth/status', (req, res) => {
  const initialized = auth.isInitialized();
  const protectionEnabled = auth.loginProtectionEnabled();
  const loggedIn = !protectionEnabled || auth.validateSession(sessionToken(req));
  res.json({
    initialized,
    logged_in: loggedIn,
    login_protection_enabled: protectionEnabled,
  });
});

/* ---------------- 登录（限速 + 2FA 两段式） ---------------- */

publicRouter.post('/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const { username, password, totp } = req.body || {};
  const throttle = auth.loginThrottleStatus(ip);
  if (!throttle.allowed) {
    return res.status(429).json({
      error: `尝试次数过多，请 ${Math.ceil(throttle.retryAfterSec / 60)} 分钟后重试`,
      retry_after: throttle.retryAfterSec,
      locked: true,
    });
  }
  const result = await auth.verifyCredentials(username, password, totp);
  if (!result.ok) {
    if (result.needTotp) {
      // 2FA 第一段：密码正确，需动态码（前端契约：400 + code=TOTP_REQUIRED）
      return res
        .status(400)
        .json({ code: 'TOTP_REQUIRED', error: '该账号已开启 2FA，请输入动态码' });
    }
    const fail = auth.recordLoginFailure(ip);
    return res.status(429).json({
      error: fail.locked
        ? `尝试次数过多，请 ${Math.ceil(fail.retryAfterSec / 60)} 分钟后重试`
        : '用户名或密码错误',
      retry_after: fail.retryAfterSec,
      locked: fail.locked,
    });
  }
  auth.clearLoginFailures(ip);
  const session = auth.issueSession();
  setSidCookie(res, session.token, session.expiresAt);
  res.json({ ok: true, username: result.user.username });
});

/* ================= 受保护路由（需登录） ================= */

protectedRouter.use(authRequired);

/* ---------------- 登出 ---------------- */

protectedRouter.post('/auth/logout', (req, res) => {
  auth.revokeSession(sessionToken(req));
  res.clearCookie(SID_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------------- 修改密码 / 用户名（吊销全部会话） ---------------- */

protectedRouter.put('/auth/password', async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const user = auth.getCurrentUser();
  if (!user) return res.status(400).json({ error: '账号未初始化' });
  let ok = false;
  try {
    ok = await argon2.verify(user.password_hash, current_password || '');
  } catch {
    ok = false;
  }
  if (!ok) return res.status(400).json({ error: '当前密码错误' });
  const pwCheck = auth.validatePasswordStrength(new_password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });
  const hash = await argon2.hash(new_password, auth.ARGON2_OPTS);
  db()
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = 1')
    .run(hash, new Date().toISOString());
  auth.revokeAllSessions();
  res.clearCookie(SID_COOKIE, { path: '/' });
  res.json({ ok: true });
});

protectedRouter.put('/auth/username', async (req, res) => {
  const { current_password, new_username } = req.body || {};
  const user = auth.getCurrentUser();
  if (!user) return res.status(400).json({ error: '账号未初始化' });
  let ok = false;
  try {
    ok = await argon2.verify(user.password_hash, current_password || '');
  } catch {
    ok = false;
  }
  if (!ok) return res.status(400).json({ error: '当前密码错误' });
  const nameCheck = auth.validateUsername(new_username);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.reason });
  db()
    .prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = 1')
    .run(new_username, new Date().toISOString());
  auth.revokeAllSessions();
  res.clearCookie(SID_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------------- 2FA ---------------- */

protectedRouter.post('/auth/2fa/setup', (req, res) => {
  const gen = auth.generateTotp();
  pendingTotp.set('pending', { secret: gen.secret, createdAt: Date.now() });
  res.json({ secret: gen.secret, otpauth_uri: gen.otpauth_uri });
});

protectedRouter.post('/auth/2fa/enable', (req, res) => {
  const { totp } = req.body || {};
  const pending = pendingTotp.get('pending');
  if (!pending) return res.status(400).json({ error: '请先执行 2FA 设置获取密钥' });
  const result = auth.enableTotp(totp, pending.secret);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  pendingTotp.delete('pending');
  res.json({ ok: true });
});

protectedRouter.post('/auth/2fa/disable', async (req, res) => {
  const { totp, password } = req.body || {};
  const result = await auth.disableTotp({ totp, password });
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ ok: true });
});

protectedRouter.post('/auth/2fa/regenerate', (req, res) => {
  const { totp } = req.body || {};
  const result = auth.regenerateTotp(totp);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  pendingTotp.set('pending', { secret: result.secret, createdAt: Date.now() });
  res.json({ secret: result.secret, otpauth_uri: result.otpauth_uri });
});
