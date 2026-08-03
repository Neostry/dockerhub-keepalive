/**
 * routes/settings.js — 设置路由（F5a 登录保护 / F11 清理兜底 / F14 F15 通知配置）
 *
 * - 登录保护开关关闭须 confirm:true + 风险提示（产品已设计）
 * - 清理兜底：prune_enabled + restart_cron（空=关闭）；保存后重建重启调度
 * - 通知配置：凭证加密入库（仅写不读），敏感字段留空 = 保持原值；测试按钮按当前配置发送
 */

import { Router } from 'express';
import * as settings from '../services/settings.js';
import * as notify from '../services/notify.js';
import { validateCron } from '../services/tasks.js';

export function createSettingsRouter({ scheduler, executor } = {}) {
  const router = Router();

  /* ---------------- 登录保护开关（F5a） ---------------- */

  router.get('/settings/login-protection', (req, res) => {
    res.json({ enabled: settings.getBool('login_protection_enabled') });
  });

  router.put('/settings/login-protection', (req, res) => {
    const { enabled, confirm } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须为布尔值' });
    }
    if (enabled === false && confirm !== true) {
      return res.status(400).json({
        error: '关闭登录保护将导致 WebUI 无内置认证，须由外部访问控制（如 Cloudflare Access）保护，请确认',
        need_confirm: true,
      });
    }
    settings.set('login_protection_enabled', enabled ? '1' : '0');
    res.json({ enabled });
  });

  /* ---------------- 清理兜底（F11） ---------------- */

  router.get('/settings/cleanup', (req, res) => {
    res.json({
      prune_enabled: settings.getBool('prune_enabled'),
      restart_cron: settings.get('restart_cron', ''),
    });
  });

  router.put('/settings/cleanup', (req, res) => {
    const { prune_enabled, restart_cron } = req.body || {};
    if (typeof prune_enabled !== 'boolean') {
      return res.status(400).json({ error: 'prune_enabled 必须为布尔值' });
    }
    const rc = restart_cron === undefined || restart_cron === null ? '' : String(restart_cron).trim();
    if (rc !== '') {
      const cronErr = validateCron(rc);
      if (cronErr) return res.status(400).json({ error: `restart_cron ${cronErr}` });
    }
    settings.set('prune_enabled', prune_enabled ? '1' : '0');
    settings.set('restart_cron', rc);
    // 重建调度（含定时重启注册）
    scheduler.rebuildRegistry();
    res.json({ prune_enabled, restart_cron: rc });
  });

  /* ---------------- 立即执行清理 ---------------- */

  router.post('/cleanup/run', (req, res) => {
    if (!settings.getBool('prune_enabled')) {
      return res.status(400).json({ error: '深度清理未开启，请先在控制中心开启 prune 开关' });
    }
    const result = executor.enqueue(null, 'cleanup');
    if (!result.queued) return res.status(409).json({ error: result.reason });
    res.status(202).json({ ok: true, message: '清理已加入执行队列' });
  });

  /* ---------------- 通知配置状态（仅非敏感） ---------------- */

  router.get('/settings/notifications', (req, res) => {
    res.json({
      telegram: notify.getTelegramStatus(),
      smtp: notify.getSmtpStatus(),
    });
  });

  /* ---------------- Telegram ---------------- */

  router.post('/settings/notifications/telegram', (req, res) => {
    const { chat_id, bot_token } = req.body || {};
    if (chat_id === undefined && bot_token === undefined) {
      return res.status(400).json({ error: '缺少配置项' });
    }
    const status = notify.saveTelegram({ chat_id, bot_token });
    res.json(status);
  });

  router.post('/settings/notifications/telegram/test', async (req, res) => {
    const result = await notify.sendTelegram('✅ 测试消息：Docker Hub 镜像保活工具通知通道工作正常。', {
      retries: 1,
    });
    if (result.skipped) return res.status(400).json({ error: 'Telegram 未配置完整（需要 chat_id 与 bot token）' });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ ok: true });
  });

  /* ---------------- SMTP ---------------- */

  router.post('/settings/notifications/smtp', (req, res) => {
    const body = req.body || {};
    if (!body.host && !body.port && !body.username && !body.password && !body.to && !('secure' in body)) {
      return res.status(400).json({ error: '缺少配置项' });
    }
    const status = notify.saveSmtp(body);
    res.json(status);
  });

  router.post('/settings/notifications/smtp/test', async (req, res) => {
    const result = await notify.sendSmtp(
      {
        subject: '【镜像保活】测试邮件',
        html: '<p>✅ 测试邮件：Docker Hub 镜像保活工具通知通道工作正常。</p>',
      },
      { retries: 1 }
    );
    if (result.skipped) return res.status(400).json({ error: 'SMTP 未配置完整（需要 host/port/to）' });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ ok: true });
  });

  return router;
}
