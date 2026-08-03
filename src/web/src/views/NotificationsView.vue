<script setup>
import { onMounted } from 'vue'
import { useNotificationsStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'
import { formatDateTime } from '@/utils/format'

const notifs = useNotificationsStore()
const ui = useUiStore()

async function load() {
  try {
    await notifs.fetch()
  } catch (e) { ui.toast(e.message) }
}
onMounted(load)

async function markRead(n) {
  try {
    await notifs.markRead(n.id)
  } catch (e) { ui.toast(e.message) }
}
async function markAll() {
  try {
    await notifs.markAllRead()
    ui.toast('已全部标记为已读')
  } catch (e) { ui.toast(e.message) }
}
function toggleUnreadOnly() {
  notifs.unreadOnly = !notifs.unreadOnly
  notifs.page = 1
  load()
}

/* content 为汇总报告 JSON（与通知通道同构），智能解析展示 */
function parseBody(n) {
  if (n._body) return n._body
  let o = n.content
  if (typeof o === 'string') {
    try { o = JSON.parse(o) } catch { return o || '' }
  }
  if (!o || typeof o !== 'object') return o || ''
  const parts = []
  if (o.success_count !== undefined || o.fail_count !== undefined) {
    parts.push(`成功 ${o.success_count ?? 0} · 失败 ${o.fail_count ?? 0}`)
  }
  if (o.duration_ms !== undefined) parts.push(`耗时 ${fmtDur(o.duration_ms)}`)
  const cr = o.cleanup_result
  if (cr) {
    if (typeof cr === 'object' && cr.pruned === true) parts.push('本地镜像已清理释放空间')
    else if (cr === 'pruned') parts.push('本地镜像已清理释放空间')
  }
  if (o.message) parts.push(o.message)
  const body = parts.join(' · ') || '—'
  n._body = body
  return body
}
function fmtDur(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return String(ms)
  if (n < 1000) return `${Math.round(n * 10) / 10}s`
  const s = Math.floor(n / 1000)
  const m = Math.floor(s / 60)
  return m === 0 ? `${s}s` : `${m}m ${s % 60}s`
}

const totalPages = () => Math.max(1, Math.ceil(notifs.total / notifs.pageSize))
function prevPage() { if (notifs.page > 1) { notifs.page--; load() } }
function nextPage() { if (notifs.page < totalPages()) { notifs.page++; load() } }
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>通知中心</h2>
        <p>任务执行汇总报告（站内信）— 与 Telegram / 邮件同源内容</p>
      </div>
      <div class="spacer"></div>
      <label class="lbl" style="display:flex;align-items:center;gap:8px;margin:0;cursor:pointer">
        <span class="switch"><input type="checkbox" :checked="notifs.unreadOnly" @change="toggleUnreadOnly"><span class="slider"></span></span>
        仅看未读
      </label>
      <button class="btn btn-sm" @click="markAll">全部已读</button>
    </div>

    <div v-if="notifs.loading && !notifs.items.length" class="loading">加载中…</div>
    <div v-else-if="!notifs.items.length" class="empty">
      <div class="big">🔔</div>
      <p>暂无通知。任务执行完成后，汇总报告会显示在这里。</p>
    </div>

    <div v-else class="notif-list">
      <div v-for="n in notifs.items" :key="n.id" class="notif-row" :class="{ unread: !n.read }">
        <span class="notif-dot" :class="{ u: !n.read }"></span>
        <div class="notif-main">
          <div class="notif-title">
            {{ n.title }}
            <span v-if="n.type === 'system'" class="pill" style="background:rgba(245,185,74,.15);color:var(--warn)">系统</span>
            <span v-if="!n.read" class="pill" style="background:rgba(62,195,240,.15);color:var(--accent)">未读</span>
          </div>
          <div class="notif-body">{{ parseBody(n) }}</div>
          <div class="notif-time">{{ formatDateTime(n.created_at) }}</div>
        </div>
        <div class="notif-ops">
          <button v-if="!n.read" class="btn btn-sm btn-ghost" @click="markRead(n)">标记已读</button>
        </div>
      </div>
    </div>

    <div v-if="notifs.total > 0" class="pager">
      <button class="btn btn-sm" :disabled="notifs.page <= 1" @click="prevPage">上一页</button>
      <span class="pg-info">{{ notifs.page }} / {{ totalPages() }} · 共 {{ notifs.total }} 条</span>
      <button class="btn btn-sm" :disabled="notifs.page >= totalPages()" @click="nextPage">下一页</button>
    </div>
  </div>
</template>
