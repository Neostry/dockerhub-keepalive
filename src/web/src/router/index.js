import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  { path: '/setup', name: 'setup', component: () => import('@/views/SetupView.vue') },
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
  { path: '/error', name: 'error', component: () => import('@/views/ErrorView.vue') },
  {
    path: '/',
    component: () => import('@/views/AppLayout.vue'),
    children: [
      { path: '', name: 'tasks', component: () => import('@/views/TasksView.vue') },
      { path: 'logs', name: 'logs', component: () => import('@/views/LogsView.vue') },
      { path: 'notifications', name: 'notifications', component: () => import('@/views/NotificationsView.vue') },
      { path: 'settings', name: 'settings', component: () => import('@/views/SettingsView.vue') }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  linkExactActiveClass: 'active'
})

// 全局守卫：由 GET /api/auth/status 驱动（F5a 免登录模式：logged_in=true 直接放行应用页）
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.loaded && !auth.loadFailed) {
    try { await auth.fetchStatus() } catch { /* loadFailed 已在 store 内置位 */ }
  }
  if (auth.loadFailed) {
    return to.path === '/error' ? true : { path: '/error' }
  }
  // 未初始化 → 强制首次设置页（登录页也不可用）
  if (!auth.initialized) {
    return to.path === '/setup' ? true : { path: '/setup' }
  }
  // 未认证（登录保护开启且未登录）→ 登录页
  if (!auth.loggedIn) {
    return to.path === '/login' ? true : { path: '/login' }
  }
  // 已认证（含免登录模式）→ 登录/设置页不可访问
  if (to.path === '/setup' || to.path === '/login') return { path: '/' }
  return true
})

// 会话失效（401 / 改密吊销）：清本地态并回登录页
window.addEventListener('auth:unauthorized', () => {
  const auth = useAuthStore()
  auth.forceLogout()
  if (router.currentRoute.value.path !== '/login') {
    router.push('/login')
  }
})

export default router
