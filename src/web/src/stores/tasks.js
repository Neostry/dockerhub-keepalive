import { defineStore } from 'pinia'
import * as api from '@/api'

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    items: [],
    loading: false,
    detail: null       // 任务详情（含 repos 快照）
  }),
  actions: {
    async fetchTasks() {
      this.loading = true
      try {
        const d = await api.listTasks()
        this.items = d.items || []
      } finally {
        this.loading = false
      }
    },
    async create(payload) {
      await api.createTask(payload)
      await this.fetchTasks()
    },
    async update(id, payload) {
      await api.updateTask(id, payload)
      await this.fetchTasks()
    },
    async remove(id) {
      await api.deleteTask(id)
      await this.fetchTasks()
    },
    /** 立即执行（202 入队，异步执行不阻塞） */
    async run(id) {
      await api.runTask(id)
    },
    async fetchDetail(id) {
      this.detail = await api.getTask(id)
      return this.detail
    },
    async scan(username, limit) {
      const body = { username }
      if (limit) body.limit = limit
      return api.scanUsername(body)
    }
  }
})
