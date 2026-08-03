// 统一请求封装：JSON 序列化、204 空响应、错误携带 status/message
// 会话由后端 HttpOnly Cookie（sid）维护，浏览器自动携带（same-origin）

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function request(method, path, body) {
  let res
  try {
    const opts = { method, headers: {}, credentials: 'same-origin' }
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    res = await fetch('/api' + path, opts)
  } catch {
    throw new ApiError('无法连接后端服务，请确认服务已启动后刷新页面', 0)
  }

  if (res.status === 204) return null

  let data = null
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    try { data = await res.json() } catch { data = null }
  }

  if (!res.ok) {
    const msg = data && data.message ? data.message : `请求失败（HTTP ${res.status}）`
    const err = new ApiError(msg, res.status, data)
    if (res.status === 401) {
      // 会话失效（过期 / 改密吊销 / 登出）：通知全局处理跳转登录
      window.dispatchEvent(new CustomEvent('auth:unauthorized'))
    }
    throw err
  }
  return data
}

export const http = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  delete: (path) => request('DELETE', path)
}
