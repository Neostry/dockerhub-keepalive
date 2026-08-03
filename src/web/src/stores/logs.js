import { defineStore } from 'pinia'
import * as api from '@/api'

export const useLogsStore = defineStore('logs', {
  state: () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    filterTaskId: '',
    filterStatus: '',
    loading: false,
    detail: null
  }),
  actions: {
    async fetchLogs({ taskId, status, page, pageSize } = {}) {
      const params = {
        page: page || this.page,
        page_size: pageSize || this.pageSize
      }
      const tid = taskId !== undefined ? taskId : this.filterTaskId
      const st = status !== undefined ? status : this.filterStatus
      if (tid) params.task_id = tid
      if (st) params.status = st
      this.loading = true
      try {
        const d = await api.listLogs(params)
        this.items = d.items || []
        this.total = d.total || 0
        this.page = d.page || 1
        if (pageSize) this.pageSize = pageSize
      } finally {
        this.loading = false
      }
    },
    async fetchDetail(id) {
      this.detail = await api.getLog(id)
      return this.detail
    }
  }
})
