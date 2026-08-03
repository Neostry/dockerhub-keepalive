<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { formatBytes, validateCron, validateRepoPath } from '@/utils/format'

const props = defineProps({
  // 传入任务对象 = 编辑模式；null = 新增
  task: { type: Object, default: null }
})
const emit = defineEmits(['close', 'saved'])

const tasks = useTasksStore()
const ui = useUiStore()

const isEdit = computed(() => !!props.task)
const seg = ref(props.task ? (props.task.type === 'username' ? 1 : 2) : 1)
const name = ref(props.task ? props.task.name : '')
const cronExpr = ref(props.task ? props.task.cron_expr : '0 3 1 * *')

/* ---- 方式一：用户名扫描 ---- */
const scanUser = ref(props.task && props.task.type === 'username' ? props.task.source : '')
const scanning = ref(false)
const scanResult = ref(null)   // {repos, total_size, truncated, failed}
const scanChecked = ref([])    // 已勾选 repo 名集合（字符串数组）
const saving = ref(false)

/* ---- 方式二：镜像路径 ---- */
const repoText = ref('')
const repoErr = ref('')

// 编辑 image 任务：预填已保存仓库
if (props.task && props.task.type === 'image') {
  repoText.value = (props.task.repos || []).map((r) => r.repo).join('\n')
}

watch(scanResult, (r) => {
  if (r && r.repos) scanChecked.value = r.repos.map((x) => x.repo)
})

function switchSeg(n) {
  if (isEdit.value) return
  seg.value = n
}

async function doScan() {
  const u = scanUser.value.trim()
  if (!u) { ui.toast('请输入 Docker Hub 用户名'); return }
  scanning.value = true
  scanResult.value = null
  try {
    const r = await tasks.scan(u)
    scanResult.value = r
    if (!r.repos.length) ui.toast('该用户名下没有公开镜像')
  } catch (e) {
    ui.toast(e.message)
  } finally {
    scanning.value = false
  }
}

function toggleCheck(repo) {
  const i = scanChecked.value.indexOf(repo)
  if (i >= 0) scanChecked.value.splice(i, 1)
  else scanChecked.value.push(repo)
}

/* ---- 保存 ---- */
const checkedRepos = computed(() => {
  if (!scanResult.value) return []
  return scanResult.value.repos.filter((r) => scanChecked.value.includes(r.repo))
})

async function save() {
  const cron = cronExpr.value.trim()
  repoErr.value = ''
  if (!name.value.trim()) { ui.toast('请填写任务名称'); return }
  if (!validateCron(cron)) { ui.toast('cron 表达式格式不正确，示例：0 3 1 * *'); return }

  let payload
  if (seg.value === 1) {
    const u = scanUser.value.trim()
    if (!u) { ui.toast('请先输入用户名并扫描'); return }
    if (!scanResult.value) { ui.toast('请先扫描镜像'); return }
    if (!checkedRepos.value.length) { ui.toast('请至少勾选一个镜像'); return }
    payload = {
      name: name.value.trim(),
      type: 'username',
      source: u,
      selected_repos: checkedRepos.value,
      cron_expr: cron
    }
  } else {
    const rows = repoText.value.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!rows.length) { ui.toast('请输入至少一个镜像路径'); return }
    const bad = rows.filter((r) => !validateRepoPath(r))
    if (bad.length) {
      repoErr.value = `以下行格式非法（需 namespace/repo，可带 :tag）：${bad.join('、')}`
      return
    }
    payload = {
      name: name.value.trim(),
      type: 'image',
      images: rows,
      cron_expr: cron
    }
  }

  saving.value = true
  try {
    if (isEdit.value) await tasks.update(props.task.id, payload)
    else await tasks.create(payload)
    ui.toast(isEdit.value ? '任务已更新' : '任务已保存，等待 cron 触发')
    emit('saved')
    emit('close')
  } catch (e) {
    ui.toast(e.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ isEdit ? '编辑保活任务' : '添加保活任务' }}</h3>
        <button class="x" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="set-row">
          <div class="field">
            <label class="lbl">任务名称</label>
            <input v-model="name" class="input" placeholder="例如 octocat 用户名扫描 / library/nginx">
          </div>
        </div>

        <div class="seg">
          <button :class="{ on: seg === 1 }" @click="switchSeg(1)">方式一 · Docker Hub 用户名</button>
          <button :class="{ on: seg === 2 }" @click="switchSeg(2)">方式二 · 单个镜像路径</button>
        </div>

        <!-- 方式一 -->
        <div v-show="seg === 1">
          <div class="set-row">
            <div class="field">
              <label class="lbl">Docker Hub 用户名</label>
              <div style="display:flex;gap:8px">
                <input v-model="scanUser" class="input mono" placeholder="例如 octocat" style="flex:1" :disabled="scanning">
                <button class="btn" :disabled="scanning" @click="doScan">{{ scanning ? '扫描中…' : '扫描镜像' }}</button>
              </div>
              <div class="hint">自动扫描该用户名下<b>全部公开镜像</b>（分页拉取，数量上限默认 50，规避 Docker Hub 限流）</div>
            </div>
          </div>
          <div v-if="scanResult" class="scan-result" style="display:block">
            <div class="scan-head">
              <span>扫描结果（共 <b>{{ scanResult.repos.length }}</b> 个公开镜像 · 合计 <b style="color:var(--accent)">{{ formatBytes(scanResult.total_size) }}</b>）</span>
              <span class="mono">已选 <b>{{ scanChecked.length }}</b></span>
            </div>
            <div class="scan-list">
              <label v-for="r in scanResult.repos" :key="r.repo" class="scan-item">
                <input type="checkbox" :checked="scanChecked.includes(r.repo)" @change="toggleCheck(r.repo)">
                <span class="repo">{{ r.repo }}</span>
                <span class="st">{{ formatBytes(r.storage_size) }}</span>
              </label>
            </div>
            <div v-if="scanResult.truncated" class="scan-fail">共 {{ scanResult.repos.length }} 个仓库，仅展示前 {{ scanResult.repos.length }} 个（超出上限，可调大 MAX_REPOS_SCAN）</div>
            <div v-for="f in scanResult.failed || []" :key="'f-' + f.repo" class="scan-fail">扫描失败：{{ f.repo }} — {{ f.reason }}</div>
          </div>
        </div>

        <!-- 方式二 -->
        <div v-show="seg === 2">
          <div class="field">
            <label class="lbl">镜像路径（namespace/repo，每行一个，支持批量）</label>
            <textarea v-model="repoText" class="input mono" rows="4" placeholder="library/nginx&#10;library/redis&#10;myorg/mytool"></textarea>
            <div class="hint">格式：<span class="ex">namespace/repo</span>（小写字母/数字/横线，可带 :tag）；非法行会单独标注</div>
            <div v-if="repoErr" class="hint" style="color:var(--err)">{{ repoErr }}</div>
          </div>
        </div>

        <div class="field" style="margin-top:16px">
          <label class="lbl">执行计划（cron 表达式）</label>
          <input v-model="cronExpr" class="input mono" placeholder="0 3 1 * *">
          <div class="hint">默认示例：<span class="ex">0 3 1 * *</span> = 每月 1 日 03:00；支持任意标准 5 段 cron</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" @click="emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存任务' }}</button>
      </div>
    </div>
  </div>
</template>
