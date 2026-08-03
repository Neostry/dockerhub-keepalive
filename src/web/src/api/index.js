// 全部 REST API 函数 —— 严格对齐 系统架构设计_Architecture.md 第 3 节接口契约
// 凭证类字段（bot_token / smtp password）留空 = 省略字段 = 保持原值（仅写不读）

import { http } from './http'

/* ============ 模块 A：账号与安全 ============ */
export const setup = (body) => http.post('/setup', body) // {username, password} → 201
export const authStatus = () => http.get('/auth/status') // {initialized, logged_in, login_protection_enabled}
export const login = (body) => http.post('/auth/login', body) // {username, password, totp?} → Set-Cookie sid
export const logout = () => http.post('/auth/logout')
export const changePassword = (body) => http.put('/auth/password', body) // {current_password, new_password}
export const changeUsername = (body) => http.put('/auth/username', body) // {current_password, new_username}
export const twofaSetup = () => http.post('/auth/2fa/setup') // → {secret, otpauth_uri}
export const twofaEnable = (body) => http.post('/auth/2fa/enable', body) // {totp}
export const twofaDisable = (body) => http.post('/auth/2fa/disable', body) // {totp} 或 {password}
export const twofaRegenerate = (body) => http.post('/auth/2fa/regenerate', body) // {totp} → {secret, otpauth_uri}
export const getLoginProtection = () => http.get('/settings/login-protection') // → {enabled}
export const setLoginProtection = (body) => http.put('/settings/login-protection', body) // {enabled, confirm?}

/* ============ 模块 B：任务配置与扫描 ============ */
export const listTasks = () => http.get('/tasks') // → {items:[...]}
export const createTask = (body) => http.post('/tasks', body)
// username 型：{name,type:'username',source,selected_repos:[...],cron_expr}
// image 型：{name,type:'image',images:['ns/repo',...],cron_expr}
export const getTask = (id) => http.get(`/tasks/${id}`) // → {...task, repos:[...]}
export const updateTask = (id, body) => http.put(`/tasks/${id}`, body)
export const deleteTask = (id) => http.delete(`/tasks/${id}`)
export const runTask = (id) => http.post(`/tasks/${id}/run`) // 202 入队
export const scanUsername = (body) => http.post('/scan/username', body) // {username, limit?} → {repos, total_size, truncated, failed}

/* ============ 模块 C：调度与清理 ============ */
export const runCleanup = () => http.post('/cleanup/run') // 202 入队；prune 未开启 → 400
export const getCleanupSettings = () => http.get('/settings/cleanup') // → {prune_enabled, restart_cron}
export const saveCleanupSettings = (body) => http.put('/settings/cleanup', body) // {prune_enabled, restart_cron}

/* ============ 模块 D：日志与通知 ============ */
export const listLogs = (params = {}) => http.get(`/logs?${new URLSearchParams(params)}`) // {items, total, page}
export const getLog = (id) => http.get(`/logs/${id}`) // → {...log, items:[...]}
export const listNotifications = (params = {}) => http.get(`/notifications?${new URLSearchParams(params)}`)
export const markNotificationRead = (id) => http.post(`/notifications/${id}/read`)
export const markAllNotificationsRead = () => http.post('/notifications/read-all')
export const getNotificationSettings = () => http.get('/settings/notifications') // → {telegram:{configured,chat_id?}, smtp:{configured,...}}
export const saveTelegram = (body) => http.post('/settings/notifications/telegram', body) // {chat_id, bot_token?}
export const testTelegram = () => http.post('/settings/notifications/telegram/test')
export const saveSmtp = (body) => http.post('/settings/notifications/smtp', body) // {host,port,secure?,username?,password?,to}
export const testSmtp = () => http.post('/settings/notifications/smtp/test')

/* ============ 模块 E：系统基础 ============ */
export const systemStatus = () => http.get('/status') // {username, login_protection_enabled, disk:{available_bytes}, next_run_at, unread_count}
export const health = () => http.get('/health')
