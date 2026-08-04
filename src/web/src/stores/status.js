import { defineStore } from 'pinia'
import * as api from '@/api'

// 侧边栏状态：用户名 / 免登录标识 / 可用空间 / 距下次任务 / 通知未读数
export const useStatusStore = defineStore('status', {
  state: () => ({
    username: '',
    loginProtectionEnabled: true,
    diskAvailable: null,     // 可用空间（字节）
    nextRunAt: null,
    unreadCount: 0,
    totpEnabled: null,       // 可选字段：2FA 状态（契约补充，见前端实现说明）
    version: '',             // 版本号：从 /api/status 动态读取（单源改造）
    loaded: false,
    timer: null
  }),
  actions: {
    async fetch() {
      const s = await api.systemStatus()
      this.username = s.username || ''
      this.loginProtectionEnabled = s.login_protection_enabled !== false
      this.diskAvailable = s.disk?.available_bytes ?? null
      this.nextRunAt = s.next_run_at ?? null
      this.unreadCount = s.unread_count || 0
      if (s.totp_enabled !== undefined) this.totpEnabled = !!s.totp_enabled
      this.version = s.version || ''
      this.loaded = true
      return s
    },
    /** 启动 30s 轮询（未读数 / 空间 / 下次执行） */
    startPolling() {
      if (this.timer) return
      this.timer = setInterval(() => { this.fetch().catch(() => {}) }, 30000)
    },
    stopPolling() {
      if (this.timer) { clearInterval(this.timer); this.timer = null }
    }
  }
})
