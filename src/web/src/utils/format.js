// 格式化工具（字节 / 时间 / cron / 镜像路径）

/** 字节数 → 人类可读（"3.2 GB" / "184 MB"）；null/undefined → "—" */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '—'
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`
}

/** 容量显示（任务/仓库场景），null → "—" */
export function formatSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '—'
  return formatBytes(bytes)
}

function pad(n) { return String(n).padStart(2, '0') }

/** 时间 → "YYYY-MM-DD HH:mm"；非法输入原样返回 */
export function formatTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 时间 → "YYYY-MM-DD HH:mm:ss"；非法输入原样返回 */
export function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return `${formatTime(value)}:${pad(d.getSeconds())}`
}

/** 毫秒 → "2m 11s" / "18s" / "1.2s"；null → "—" */
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—'
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n * 10) / 10}s`
  const s = Math.floor(n / 1000)
  const m = Math.floor(s / 60)
  if (m === 0) return `${s}s`
  const h = Math.floor(m / 60)
  if (h === 0) return `${m}m ${s % 60}s`
  return `${h}h ${m % 60}m`
}

/** 简单 cron 校验：标准 5 段（前端预校验，服务端 croner 为准） */
export function validateCron(expr) {
  if (typeof expr !== 'string') return false
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const field = (s) => /^(\*|\d+|\d+-\d+|\*\/\d+|\d+\/\d+|\d+-\d+\/\d+)(,(\*|\d+|\d+-\d+|\*\/\d+|\d+\/\d+|\d+-\d+\/\d+))*$/.test(s)
  return parts.every(field)
}

/** 镜像路径校验：namespace/repo[:tag]（小写字母数字，支持 . _ -） */
export function validateRepoPath(line) {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-zA-Z0-9._-]+)?$/.test(line)
}

/** 任务上次执行状态 → 标签文案与样式类 */
export function lastRunMeta(status) {
  switch (status) {
    case 'success': return { text: '上次成功', cls: 'tag-ok' }
    case 'partial': return { text: '部分成功', cls: 'tag-warn' }
    case 'failed': return { text: '上次失败', cls: 'tag-fail' }
    case 'skipped': return { text: '已跳过', cls: 'tag-off' }
    case 'running': return { text: '执行中', cls: 'tag-run' }
    default: return { text: '待执行', cls: 'tag-scan' }
  }
}

/** 日志状态 → 圆点类 */
export function logStateCls(status) {
  return { success: 'ok', partial: 'partial', failed: 'fail', skipped: 'skipped', running: 'running' }[status] || 'skipped'
}

/** 触发方式文案 */
export function triggerText(t) {
  return { cron: 'cron 定时', manual: '手动', cleanup: '手动清理' }[t] || t || '—'
}

/** 任务类型文案 */
export function typeText(type) {
  return type === 'username' ? '用户名扫描' : '镜像'
}
