import { defineStore } from 'pinia'

// 全局轻量 UI 状态：toast 提示
let toastTimer = null

export const useUiStore = defineStore('ui', {
  state: () => ({
    toastMsg: '',
    toastShow: false
  }),
  actions: {
    toast(msg) {
      this.toastMsg = msg
      this.toastShow = true
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { this.toastShow = false }, 2600)
    }
  }
})
