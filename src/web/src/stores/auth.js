import { defineStore } from 'pinia'
import * as api from '@/api'

// 认证与首次设置状态 —— 由 GET /api/auth/status 驱动（F5a 免登录模式：logged_in=true 时直接放行）
export const useAuthStore = defineStore('auth', {
  state: () => ({
    loaded: false,          // auth/status 已加载
    loadFailed: false,      // 后端不可达（网络层错误）
    initialized: false,     // 是否完成首次设置
    loggedIn: false,        // 已认证（免登录模式下服务端返回 true）
    loginProtectionEnabled: true,
    username: ''
  }),
  actions: {
    async fetchStatus() {
      try {
        const s = await api.authStatus()
        this.initialized = !!s.initialized
        this.loggedIn = !!s.logged_in
        this.loginProtectionEnabled = s.login_protection_enabled !== false
        this.loadFailed = false
        return s
      } catch (e) {
        if (e.status === 0) this.loadFailed = true
        throw e
      } finally {
        this.loaded = true
      }
    },
    async setupAccount(username, password) {
      await api.setup({ username, password })
      this.initialized = true
      this.username = username
    },
    /** 两段式登录：返回 {needTotp}；needTotp=true 时调用方需收集动态码后带 totp 重试 */
    async login({ username, password, totp }) {
      const body = { username, password }
      if (totp) body.totp = totp
      const data = await api.login(body)
      if (data && data.requires_totp) return { needTotp: true }
      this.loggedIn = true
      this.username = username
      this.loaded = true
      return { needTotp: false }
    },
    async logout() {
      try { await api.logout() } catch { /* 忽略网络错误，本地态必清 */ }
      this.loggedIn = false
      this.username = ''
    },
    /** 会话失效（401）或改密/改名后被吊销：清本地态（路由守卫会自动跳登录） */
    forceLogout() {
      this.loggedIn = false
    },
    async setLoginProtection(enabled, confirm) {
      await api.setLoginProtection({ enabled, confirm: !!confirm })
      this.loginProtectionEnabled = enabled
      if (!enabled) {
        // 免登录模式：认证中间件视为已认证，前端据此进入应用页
        this.loggedIn = true
        this.initialized = true
      }
    }
  }
})
