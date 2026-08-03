import { defineStore } from 'pinia'
import * as api from '@/api'

export const useNotificationsStore = defineStore('notifications', {
  state: () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    unreadOnly: false,
    unreadCount: 0,
    loading: false
  }),
  actions: {
    async fetch({ unreadOnly, page, pageSize } = {}) {
      const params = { page: page || this.page, page_size: pageSize || this.pageSize }
      const uo = unreadOnly !== undefined ? unreadOnly : this.unreadOnly
      if (uo) params.unread_only = 'true'
      this.loading = true
      try {
        const d = await api.listNotifications(params)
        this.items = d.items || []
        this.total = d.total || 0
        this.page = d.page || 1
        if (pageSize) this.pageSize = pageSize
        if (d.unread_count !== undefined) this.unreadCount = d.unread_count
      } finally {
        this.loading = false
      }
    },
    async markRead(id) {
      await api.markNotificationRead(id)
      const n = this.items.find((x) => x.id === id)
      if (n) n.read = 1
      if (this.unreadCount > 0) this.unreadCount--
    },
    async markAllRead() {
      await api.markAllNotificationsRead()
      this.items.forEach((n) => { n.read = 1 })
      this.unreadCount = 0
    }
  }
})
