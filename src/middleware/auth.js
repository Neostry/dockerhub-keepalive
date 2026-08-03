/**
 * middleware/auth.js — 认证中间件（模块 A/E）
 *
 * - F5a 免登录模式：login_protection_enabled=0 时直接放行（视为已认证）
 * - 否则校验 Cookie sid（HttpOnly）对应服务端会话（token 哈希）
 * - 安全响应头：CSP / X-Content-Type-Options / X-Frame-Options / Referrer-Policy
 */

import config from '../config.js';
import * as auth from '../services/auth.js';

export const SID_COOKIE = 'sid';

/** 解析来源 IP：TRUST_PROXY 时取 X-Forwarded-For 首个地址（防伪造默认不信任） */
export function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** 会话 token 从 Cookie 提取 */
export function sessionToken(req) {
  return req.cookies?.[SID_COOKIE] || null;
}

/**
 * 认证中间件：所有 /api 业务路由挂载。
 * 免登录模式 → 放行；否则校验会话，失败 401。
 */
export function authRequired(req, res, next) {
  if (!auth.loginProtectionEnabled()) {
    res.locals.authed = true; // 免登录模式
    res.locals.loginFree = true;
    return next();
  }
  const token = sessionToken(req);
  if (!auth.validateSession(token)) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  res.locals.authed = true;
  res.locals.sessionToken = token;
  return next();
}

/** 安全响应头（全局挂载） */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // CSP：自托管无外链资源；qrcode 为 canvas 生成，无需外源
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
  );
  next();
}

/** 404 统一处理（API 路径） */
export function notFound(req, res) {
  res.status(404).json({ error: '接口不存在' });
}

/** 统一错误处理：普通 Error → 500；带 status 的 → 对应状态码 */
export function errorHandler(err, req, res, next) {
  // eslint-disable-next-line no-unused-vars
  const status = err.status || (err.code === 'NOT_FOUND' ? 404 : 500);
  if (status >= 500) console.error('[api] 错误：', err.message);
  res.status(status).json({ error: err.expose !== false ? err.message : '服务器内部错误' });
}
