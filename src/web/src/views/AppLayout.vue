<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useStatusStore } from '@/stores/status'
import LogoIcon from '@/components/LogoIcon.vue'
import { formatBytes, formatTime } from '@/utils/format'

const auth = useAuthStore()
const status = useStatusStore()
const router = useRouter()

onMounted(async () => {
  status.fetch().catch(() => {})
  status.startPolling()
})
onBeforeUnmount(() => status.stopPolling())

function nextRunText() {
  if (!status.nextRunAt) return '距下次任务 —'
  const diff = new Date(status.nextRunAt).getTime() - Date.now()
  if (!Number.isFinite(diff) || diff <= 0) return '距下次任务 —'
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  return d > 0 ? `距下次任务 ${d}d ${String(h).padStart(2, '0')}h` : `距下次任务 ${h}h`
}

async function doLogout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <LogoIcon :size="30" />
        <div>
          <div class="brand-name">Docker Keepalive</div>
          <span class="brand-tag">镜像保活 · 零人工干预</span>
        </div>
      </div>
      <nav class="nav">
        <RouterLink class="nav-item" to="/">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 7l8-4 8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>
          <span>保活任务</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/logs">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>
          <span>执行日志</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/notifications">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9a6 6 0 10-12 0c0 5-2 6-2 6h16s-2-1-2-6M10 20a2.2 2.2 0 004 0"/></svg>
          <span>通知中心</span>
          <span v-if="status.unreadCount > 0" class="badge">{{ status.unreadCount > 99 ? '99+' : status.unreadCount }}</span>
        </RouterLink>
        <RouterLink class="nav-item" to="/settings">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>控制中心</span>
        </RouterLink>
      </nav>
      <div class="sidebar-foot">
        <div class="sf-health">
          <div><span class="pulse-dot"></span> 可用空间 {{ formatBytes(status.diskAvailable) }}</div>
          <div>{{ nextRunText() }}</div>
        </div>
        <div class="sf-user">
          <b>{{ status.username || auth.username }}</b>
          <span v-if="!status.loginProtectionEnabled" class="tag tag-scan">免登录模式 · 外部访问控制保护</span>
        </div>
        <button v-if="status.loginProtectionEnabled" id="logoutBtn" class="btn btn-sm btn-danger" @click="doLogout">退出登录</button>
        <div class="sf-ver">Docker Keepalive · v{{ status.version || 'unknown' }}</div>
      </div>
    </aside>
    <div class="main">
      <div class="content">
        <RouterView />
      </div>
    </div>
  </div>
</template>
