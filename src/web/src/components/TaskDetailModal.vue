<script setup>
import { onMounted, ref } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { formatSize, formatTime, typeText } from '@/utils/format'

const props = defineProps({
  task: { type: Object, required: true }   // 列表项（含 id）
})
const emit = defineEmits(['close'])

const tasks = useTasksStore()
const detail = ref(null)
const loading = ref(true)

onMounted(async () => {
  try {
    detail.value = await tasks.fetchDetail(props.task.id)
  } catch { /* 父组件 toast */ } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal modal-lg">
      <div class="modal-head">
        <h3>{{ detail ? (typeText(detail.type) + ' · ' + detail.source + ' · 仓库详情') : '任务详情' }}</h3>
        <button class="x" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <template v-if="loading">
          <div class="loading">加载中…</div>
        </template>
        <template v-else-if="detail">
          <div class="meta-grid">
            <div class="meta-box"><div class="k">仓库数</div><div class="v">{{ (detail.repos || []).length }} 个</div></div>
            <div class="meta-box"><div class="k">估算总容量</div><div class="v">{{ formatSize(detail.estimated_size) }}</div></div>
            <div class="meta-box"><div class="k">数据来源</div><div class="v">Docker Hub API</div></div>
            <div class="meta-box"><div class="k">上次执行</div><div class="v">{{ formatTime(detail.last_run_at) }}</div></div>
          </div>
          <div class="table-wrap">
            <table class="repo-table">
              <thead><tr><th>镜像名称</th><th>最新版本</th><th>简介</th><th>容量</th><th>更新时间</th></tr></thead>
              <tbody>
                <tr v-if="!detail.repos || !detail.repos.length">
                  <td colspan="5" style="text-align:center;color:var(--ink-3);padding:24px">暂无仓库信息（任务未执行过，保存时即从 Docker Hub 获取）</td>
                </tr>
                <tr v-for="r in detail.repos || []" :key="r.repo + (r.tag || '')">
                  <td class="r">
                    <svg class="repo-logo" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" style="padding:2px"><path d="M4 7l8-4 8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>
                    {{ r.repo }}
                  </td>
                  <td class="vtag">{{ r.latest_tag || r.tag || '—' }}</td>
                  <td class="desc">{{ r.description || '—' }}</td>
                  <td class="sz">{{ formatSize(r.storage_size) }}</td>
                  <td class="up">{{ formatTime(r.last_updated) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="auth-note" style="margin-top:12px"><b>执行策略（自动，无需配置）：</b>执行前自动<b>空间预检</b>服务器可用空间；默认<b>逐个镜像「拉取 → 删除」顺序执行</b>，空间充足时受控并发——防止多镜像累计容量挤爆服务器。</div>
        </template>
      </div>
      <div class="modal-foot"><button class="btn" @click="emit('close')">关闭</button></div>
    </div>
  </div>
</template>
