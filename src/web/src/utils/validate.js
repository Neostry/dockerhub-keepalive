// 输入校验（与后端约束一致：用户名 ≥3 字符；密码 ≥8 位且含字母与数字）
export function validateUsername(u) {
  return typeof u === 'string' && u.trim().length >= 3
}
export function validatePassword(p) {
  return typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p)
}
export function validateTotp(t) {
  return /^\d{6}$/.test((t || '').trim())
}
