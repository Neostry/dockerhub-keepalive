<script setup>
import { onMounted, ref } from 'vue'
import { useLogsStore } from '@/stores/logs'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { formatDateTime, formatDuration, logStateCls, triggerText } from '@/utils/format'

const logs = useLogsStore()
const tasks = useTasksStore()
const ui = useUiStore()

const expandedId = ref(null)
const detailCache = ref({})

async function load() {
  try {
    await logs.fetchLogs()
  } catch (e) { ui.toast(e.message) }
}

onMounted(async () => {
  tasks.fetchTasks().catch(() => {})
  await load()
})

function applyFilter() {
  logs.page = 1
  load()
}

function taskName(l) {
  if (l.task_name) return l.task_name
  if (l.task_id) return `任务 #${l.task_id}`
  return '系统清理'
}

function statusText(s) {
  return { success: '成功', partial: '部分成功', failed: '失败', skipped: '跳过' }[s] || s || '—'
}
function statusCls(s) {
  return { success: 'tag-ok', partial: 'tag-warn', failed: 'tag-fail', skipped: 'tag-off' }[s] || 'tag-off'
}

/* 空间预检展示（space_check 为 JSON，字段兼容） */
function spaceText(l) {
  const sc = l.space_check
  if (!sc) return '—'
  let o = sc
  if (typeof sc === 'string') { try { o = JSON.parse(sc) } catch { return sc } }
  if (!o || typeof o !== 'object') return '—'
  const avail = o.available_bytes ?? o.available ?? o.free
  const need = o.required_bytes ?? o.estimated_size ?? o.required
  const passed = o.passed ?? o.ok
  const part = []
  if (need !== undefined) part.push(`需 ${fmt(need)}`)
  if (avail !== undefined) part.push(`可用 ${fmt(avail)}`)
  if (passed === true) return `通过 · ${part.join(' / ')}`
  if (passed === false) return `不足 · ${part.join(' / ')}`
  return part.join(' / ') || '—'
}
function fmt(v) {
  if (typeof v === 'string' && /[a-zA-Z]/.test(v)) return v
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let x = n, i = 0
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return `${x >= 100 ? Math.round(x) : x.toFixed(x >= 10 ? 1 : 2)} ${units[i]}`
}

/* 清理兜底展示（cleanup_result JSON） */
function cleanupText(l) {
  const cr = l.cleanup_result
  if (!cr) return '—'
  let o = cr
  if (typeof cr === 'string') { try { o = JSON.parse(cr) } catch { return cr } }
  if (!o || typeof o !== 'object') return '—'
  const parts = []
  if (o.rmi_retries !== undefined && Number(o.rmi_retries) > 0) parts.push(`rmi 重试 ${o.rmi_retries} 次`)
  if (o.pruned === true || o.prune_result) parts.push('prune 已执行')
  else if (o.pruned === false) parts.push('prune 未执行')
  else if (o.prune_enabled === false) parts.push('prune 未开启')
  return parts.join(' · ') || '—'
}

async function toggleExpand(l) {
  if (expandedId.value === l.id) { expandedId.value = null; return }
  expandedId.value = l.id
  if (!detailCache.value[l.id]) {
    try {
      detailCache.value[l.id] = await logs.fetchDetail(l.id)
    } catch (e) { ui.toast(e.message) }
  }
}

const totalPages = () => Math.max(1, Math.ceil(logs.total / logs.pageSize))

function prevPage() { if (logs.page > 1) { logs.page--; load() } }
function nextPage() { if (logs.page < totalPages()) { logs.page++; load() } }
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>执行日志</h2>
        <p>每次任务执行的完整记录：时间、镜像明细、成功/失败原因</p>
      </div>
      <div class="spacer"></div>
      <select v-model="logs.filterTaskId" class="input" style="width:auto;min-width:180px" @change="applyFilter">
        <option value="">全部任务</option>
        <option v-for="t in tasks.items" :key="t.id" :value="t.id">{{ t.source }}</option>
      </select>
      <select v-model="logs.filterStatus" class="input" style="width:auto;min-width:110px" @change="applyFilter">
        <option value="">全部状态</option>
        <option value="success">成功</option>
        <option value="partial">部分成功</option>
        <option value="failed">失败</option>
        <option value="skipped">跳过</option>
        <option value="running">执行中</option>
      </select>
      <button class="btn" @click="applyFilter">刷新</button>
    </div>

    <div v-if="logs.loading && !logs.items.length" class="loading">加载中…</div>
    <div v-else-if="!logs.items.length" class="empty">
      <div class="big">🗒️</div>
      <p>暂无执行日志。任务按 cron 触发后，每次执行的完整记录会显示在这里。</p>
    </div>

    <div v-else class="log-list">
      <div v-for="l in logs.items" :key="l.id" class="log-row">
        <div class="log-main" @click="toggleExpand(l)">
          <span class="log-state" :class="logStateCls(l.status)"></span>
          <div class="log-info">
            <div class="log-title">{{ taskName(l) }} <span class="tag" :class="statusCls(l.status)" style="margin-left:6px">{{ statusText(l.status) }}</span></div>
            <div class="log-sub">{{ formatDateTime(l.started_at) }} · 触发：{{ triggerText(l.trigger) }} · 耗时 {{ formatDuration(l.duration_ms) }}</div>
          </div>
          <div class="log-nums"><span class="ok">✓ {{ l.success_count ?? 0 }}</span><span class="fail">✗ {{ l.fail_count ?? 0 }}</span></div>
        </div>
        <div v-if="expandedId === l.id" class="log-detail">
          <div class="meta-grid">
            <div class="meta-box"><div class="k">执行时间</div><div class="v">{{ formatDateTime(l.started_at) }}</div></div>
            <div class="meta-box"><div class="k">触发方式</div><div class="v">{{ triggerText(l.trigger) }}</div></div>
            <div class="meta-box"><div class="k">镜像总数</div><div class="v">{{ l.total_images ?? '—' }}</div></div>
            <div class="meta-box"><div class="k">空间预检</div><div class="v">{{ spaceText(l) }}</div></div>
            <div class="meta-box"><div class="k">清理兜底</div><div class="v">{{ cleanupText(l) }}</div></div>
            <div class="meta-box"><div class="k">结束时间</div><div class="v">{{ formatDateTime(l.finished_at) }}</div></div>
          </div>
          <div v-if="detailCache[l.id]">
            <template v-if="(detailCache[l.id].items || []).length">
              <div v-for="it in detailCache[l.id].items" :key="it.id || (it.repo + it.tag + it.action)" class="detail-line">
                <span class="repo">{{ it.repo }}{{ it.tag ? ':' + it.tag : '' }}</span>
                <span class="tag" :class="it.status === 'success' ? 'tag-ok' : 'tag-fail'">
                  {{ it.action === 'pull' ? '拉取' : '删除' }} {{ it.status === 'success' ? '成功' : '失败' }}
                </span>
                <span class="dur">{{ formatDuration(it.duration_ms) }}{{ it.retries ? ` · 重试 ${it.retries} 次` : '' }}</span>
                <span v-if="it.status !== 'success' && it.message" class="why">{{ it.message }}</span>
              </div>
            </template>
            <div v-else class="hint" style="margin-top:8px">无逐镜像明细</div>
          </div>
          <div v-else class="hint" style="margin-top:8px">加载明细…</div>
        </div>
      </div>
    </div>

    <div v-if="logs.total > 0" class="pager">
      <button class="btn btn-sm" :disabled="logs.page <= 1" @click="prevPage">上一页</button>
      <span class="pg-info">{{ logs.page }} / {{ totalPages() }} · 共 {{ logs.total }} 条</span>
      <button class="btn btn-sm" :disabled="logs.page >= totalPages()" @click="nextPage">下一页</button>
    </div>
  </div>
</template>
