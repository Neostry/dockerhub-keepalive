<script setup>
import { onMounted, ref } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import TaskFormModal from '@/components/TaskFormModal.vue'
import TaskDetailModal from '@/components/TaskDetailModal.vue'
import { formatSize, formatTime, lastRunMeta, typeText } from '@/utils/format'

const tasks = useTasksStore()
const ui = useUiStore()

const showForm = ref(false)
const editingTask = ref(null)     // null = 新增
const detailTask = ref(null)      // 详情模态

// 任务头像：优先使用后端提供的 avatar_url（后端代理 Docker Hub 获取 gravatar）。
// 浏览器直连 hub.docker.com 受 CORS 限制（已实测），前端不再直连；未提供时回退默认图标。
function avatarOf(t) {
  return t.avatar_url || t.avatarUrl || ''
}

onMounted(async () => {
  await load()
})
async function load() {
  try {
    await tasks.fetchTasks()
  } catch (e) {
    ui.toast(e.message)
  }
}

function openAdd() { editingTask.value = null; showForm.value = true }
function openEdit(t) { editingTask.value = t; showForm.value = true }

async function runNow(t) {
  try {
    await tasks.run(t.id)
    ui.toast('已触发任务：' + t.source + '（异步执行，可查看日志）')
  } catch (e) {
    ui.toast(e.message)
  }
}
async function removeTask(t) {
  if (!window.confirm(`删除任务「${t.source}」？此操作不可恢复`)) return
  try {
    await tasks.remove(t.id)
    ui.toast('已删除任务')
  } catch (e) {
    ui.toast(e.message)
  }
}
async function toggleEnabled(t, on) {
  try {
    await tasks.update(t.id, { enabled: on })
    ui.toast((on ? '已启用' : '已停用') + '任务：' + t.source)
  } catch (e) {
    ui.toast(e.message)
    t.enabled = !on // 回滚
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>保活任务</h2>
        <p>配置一次，自动定期 pull 镜像防止 Docker Hub 90 天下架</p>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-primary" @click="openAdd">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="vertical-align:-2px;margin-right:4px"><path d="M12 5v14M5 12h14"/></svg>添加任务
      </button>
    </div>

    <div v-if="tasks.loading && !tasks.items.length" class="loading">加载中…</div>

    <div v-else-if="!tasks.items.length" class="empty">
      <div class="big">📦</div>
      <p>还没有保活任务。点击「添加任务」，输入 Docker Hub 用户名或镜像路径开始。</p>
    </div>

    <div v-else class="task-list">
      <div v-for="t in tasks.items" :key="t.id" class="task-card">
        <div class="task-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"><path d="M4 7l8-4 8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>
          <img v-if="avatarOf(t)" class="task-avatar" :src="avatarOf(t)" alt="" loading="lazy" @error="t.avatar_url = ''; t.avatarUrl = ''">
        </div>
        <div class="task-main">
          <div class="task-name">{{ t.source }}</div>
          <div class="task-sub">{{ typeText(t.type) }} · {{ t.image_count }} 个镜像 · 合计 {{ formatSize(t.estimated_size) }} · cron <span class="mono">{{ t.cron_expr }}</span></div>
        </div>
        <div class="task-meta">
          <div class="m"><b>{{ t.last_run_at ? formatTime(t.last_run_at).slice(5) : '—' }}</b>上次执行</div>
          <div class="m"><b>{{ t.image_count }}</b>镜像数</div>
          <div class="m"><b>{{ formatSize(t.estimated_size) }}</b>估算容量</div>
        </div>
        <span class="tag" :class="lastRunMeta(t.enabled ? t.last_run_status : null).cls">
          {{ t.enabled ? lastRunMeta(t.last_run_status).text : '已停用' }}
        </span>
        <div class="task-ops">
          <button class="btn btn-sm" title="查看镜像详情" @click="detailTask = t">详情</button>
          <button class="btn btn-sm" title="立即执行" @click="runNow(t)">立即执行</button>
          <button class="btn btn-sm" title="编辑" @click="openEdit(t)">编辑</button>
          <button class="btn btn-sm btn-danger" @click="removeTask(t)">删除</button>
          <label class="switch" title="启用/停用">
            <input type="checkbox" :checked="!!t.enabled" @change="toggleEnabled(t, $event.target.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>
    </div>

    <TaskFormModal v-if="showForm" :task="editingTask" @close="showForm = false" @saved="load" />
    <TaskDetailModal v-if="detailTask" :task="detailTask" @close="detailTask = null" />
  </div>
</template>
