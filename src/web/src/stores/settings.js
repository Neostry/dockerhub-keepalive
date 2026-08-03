import { defineStore } from 'pinia'
import * as api from '@/api'

// 控制中心设置：通知渠道（仅写不读）+ 清理兜底
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    notif: {
      telegram: { configured: false, chat_id: '' },
      smtp: { configured: false, host: '', port: '', username: '', to: '' }
    },
    cleanup: { prune_enabled: false, restart_cron: '' }
  }),
  actions: {
    async fetchNotifications() {
      const d = await api.getNotificationSettings()
      if (d) this.notif = d
    },
    /** bot_token 留空 = 保持原值（仅写不读） */
    async saveTelegram(payload) {
      await api.saveTelegram(payload)
      await this.fetchNotifications()
    },
    /** password 留空 = 保持原值（仅写不读） */
    async saveSmtp(payload) {
      await api.saveSmtp(payload)
      await this.fetchNotifications()
    },
    async testTelegram() { return api.testTelegram() },
    async testSmtp() { return api.testSmtp() },
    async fetchCleanup() {
      const d = await api.getCleanupSettings()
      if (d) this.cleanup = d
    },
    async saveCleanup(payload) {
      await api.saveCleanupSettings(payload)
      this.cleanup = { ...this.cleanup, ...payload }
    },
    /** 立即执行清理（prune 未开启时后端返回 400，需提示先开启） */
    async runCleanup() { return api.runCleanup() }
  }
})
