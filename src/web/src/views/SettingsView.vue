<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useStatusStore } from '@/stores/status'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import TwoFactorBox from '@/components/TwoFactorBox.vue'
import { validateUsername, validatePassword } from '@/utils/validate'

const router = useRouter()
const auth = useAuthStore()
const status = useStatusStore()
const settings = useSettingsStore()
const ui = useUiStore()

/* ---- 账号：修改用户名 / 密码 ---- */
const curPassU = ref('')
const newUsername = ref('')
const curPassP = ref('')
const newPass = ref('')
const newPass2 = ref('')

async function saveUsername() {
  if (!curPassU.value) { ui.toast('请输入当前密码验证身份'); return }
  const nu = newUsername.value.trim()
  if (!validateUsername(nu)) { ui.toast('用户名至少 3 个字符'); return }
  try {
    await api.changeUsername({ current_password: curPassU.value, new_username: nu })
    ui.toast('用户名已修改，请重新登录')
    auth.forceLogout()
    router.push('/login')
  } catch (e) { ui.toast(e.message) }
}

async function savePassword() {
  if (!curPassP.value) { ui.toast('请输入当前密码验证身份'); return }
  if (!validatePassword(newPass.value)) { ui.toast('新密码需至少 8 位且同时包含字母与数字'); return }
  if (newPass.value !== newPass2.value) { ui.toast('两次输入的新密码不一致'); return }
  try {
    await api.changePassword({ current_password: curPassP.value, new_password: newPass.value })
    ui.toast('密码已修改，请重新登录')
    auth.forceLogout()
    router.push('/login')
  } catch (e) { ui.toast(e.message) }
}

/* ---- 登录保护开关（F5a）：关闭需确认 + 风险提示 ---- */
async function toggleLogin(on) {
  if (!on) {
    const ok = window.confirm('关闭登录保护后，WebUI 将无需登录即可访问（需由外部访问控制保护，如 Cloudflare Access）。确认关闭？')
    if (!ok) return // 保持开启（checkbox 由 status 驱动回弹）
  }
  try {
    await auth.setLoginProtection(on, !on)
    if (!on) {
      ui.toast('登录保护已关闭：WebUI 免登录访问')
    } else {
      ui.toast('登录保护已开启，请重新登录')
      await auth.fetchStatus()
      router.push(auth.initialized ? '/login' : '/setup')
    }
  } catch (e) { ui.toast(e.message) }
}

/* ---- 通知渠道（凭证仅写不读：敏感字段留空 = 保持原值） ---- */
const tgChat = ref('')
const tgToken = ref('')
const smtpHost = ref('')
const smtpPort = ref('')
const smtpUser = ref('')
const smtpPass = ref('')
const smtpTo = ref('')
const smtpSecure = ref('auto')

function fillNotifForm() {
  const n = settings.notif
  tgChat.value = n.telegram?.chat_id || ''
  tgToken.value = ''
  smtpHost.value = n.smtp?.host || ''
  smtpPort.value = n.smtp?.port != null ? String(n.smtp.port) : ''
  smtpUser.value = n.smtp?.username || ''
  smtpPass.value = ''
  smtpTo.value = n.smtp?.to || ''
}

async function saveTelegram() {
  if (!tgChat.value.trim()) { ui.toast('请填写 Chat ID'); return }
  const payload = { chat_id: tgChat.value.trim() }
  if (tgToken.value.trim()) payload.bot_token = tgToken.value.trim() // 留空 = 保持原值
  try {
    await settings.saveTelegram(payload)
    ui.toast('Telegram 配置已保存（AES 加密存储）')
    fillNotifForm()
  } catch (e) { ui.toast(e.message) }
}

async function saveSmtp() {
  if (!smtpHost.value.trim() || !smtpPort.value.trim() || !smtpTo.value.trim()) {
    ui.toast('请填写 SMTP 主机、端口与收件人'); return
  }
  const payload = { host: smtpHost.value.trim(), port: smtpPort.value.trim(), to: smtpTo.value.trim() }
  if (smtpUser.value.trim()) payload.username = smtpUser.value.trim() // 留空 = 保持原值
  if (smtpPass.value) payload.password = smtpPass.value // 留空 = 保持原值
  if (smtpSecure.value === 'tls') payload.secure = true
  else if (smtpSecure.value === 'plain') payload.secure = false
  try {
    await settings.saveSmtp(payload)
    ui.toast('SMTP 配置已保存（AES 加密存储）')
    fillNotifForm()
  } catch (e) { ui.toast(e.message) }
}

async function testTg() {
  try {
    await settings.testTelegram()
    ui.toast('测试消息已发送至 Telegram')
  } catch (e) { ui.toast('发送失败：' + e.message) }
}
async function testSmtp() {
  try {
    await settings.testSmtp()
    ui.toast('测试邮件已发送')
  } catch (e) { ui.toast('发送失败：' + e.message) }
}

/* ---- 清理兜底 ---- */
const restartCron = ref('')
function fillCleanupForm() {
  restartCron.value = settings.cleanup.restart_cron || ''
}
async function saveCleanup() {
  try {
    await settings.saveCleanup({ prune_enabled: settings.cleanup.prune_enabled, restart_cron: restartCron.value.trim() })
    ui.toast('清理兜底配置已保存')
    fillCleanupForm()
  } catch (e) { ui.toast(e.message) }
}
async function runCleanup() {
  try {
    await settings.runCleanup()
    ui.toast('已触发深度清理（异步执行，可查看日志）')
  } catch (e) {
    ui.toast(e.message) // 未开启 prune 时后端返回 400：提示先开启
  }
}

onMounted(async () => {
  try {
    await settings.fetchNotifications()
    fillNotifForm()
  } catch (e) { ui.toast(e.message) }
  try {
    await settings.fetchCleanup()
    fillCleanupForm()
  } catch (e) { ui.toast(e.message) }
})
</script>

<template>
  <div>
    <div class="page-head">
      <div><h2>控制中心</h2><p>账号安全、通知渠道与清理兜底</p></div>
    </div>

    <!-- 账号安全 -->
    <div class="set-card">
      <div class="set-head">
        <h3>账号安全</h3>
        <span class="st" style="color:var(--ink-3)">2FA 状态见下方</span>
      </div>
      <div class="set-body">
        <div class="set-row">
          <div class="field">
            <label class="lbl" style="display:flex;align-items:center;gap:8px">
              <span class="switch">
                <input type="checkbox" :checked="status.loginProtectionEnabled" @change="toggleLogin($event.target.checked)">
                <span class="slider"></span>
              </span>
              启用登录页保护（WebUI 需登录访问）
            </label>
            <div class="hint">部署在 Cloudflare Access / 反向代理等<b>外部访问控制</b>之后时，可关闭本开关免登录访问（避免双重认证）。<b style="color:var(--warn)">关闭后 WebUI 无内置认证，请务必确认外部访问已受保护。</b></div>
          </div>
        </div>
        <div class="set-row">
          <div class="field">
            <label class="lbl">用户名</label>
            <div style="display:flex;gap:8px">
              <input v-model="newUsername" class="input" :placeholder="status.username || '新用户名'" style="flex:1">
              <input v-model="curPassU" class="input" type="password" placeholder="当前密码" style="max-width:160px">
              <button class="btn btn-sm" @click="saveUsername">保存用户名</button>
            </div>
          </div>
        </div>
        <div class="set-row">
          <div class="field">
            <label class="lbl">新密码（至少 8 位，含字母与数字；留空则不修改）</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input v-model="newPass" class="input" type="password" placeholder="新密码" style="flex:1;min-width:150px">
              <input v-model="newPass2" class="input" type="password" placeholder="确认新密码" style="flex:1;min-width:150px">
              <input v-model="curPassP" class="input" type="password" placeholder="当前密码" style="max-width:160px">
              <button class="btn btn-sm btn-primary" @click="savePassword">保存密码</button>
            </div>
            <div class="hint">修改用户名或密码后，全部会话将被吊销，需重新登录。</div>
          </div>
        </div>
        <TwoFactorBox />
      </div>
    </div>

    <!-- 通知渠道 -->
    <div class="set-card">
      <div class="set-head"><h3>通知渠道</h3><span class="st" style="color:var(--ink-3)">Telegram · 邮件 · 站内信</span></div>
      <div class="set-body">
        <div class="sub-mod">
          <div class="sub-head">
            Telegram Bot
            <span class="st-tag" :class="settings.notif.telegram?.configured ? 'st-ok' : 'st-off'">
              {{ settings.notif.telegram?.configured ? '● 已配置' : '未配置' }}
            </span>
          </div>
          <div class="sub-body">
            <div class="set-row">
              <div class="field">
                <label class="lbl">Bot Token</label>
                <input v-model="tgToken" class="input mono" type="password" placeholder="留空 = 保持原值（仅写不读）">
              </div>
              <div class="field">
                <label class="lbl">Chat ID</label>
                <input v-model="tgChat" class="input mono" placeholder="-1001234567890">
              </div>
            </div>
            <div v-if="settings.notif.telegram?.configured" class="readonly-val" style="margin-bottom:12px">
              当前 Chat ID：<span class="mono">{{ settings.notif.telegram.chat_id }}</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm btn-primary" @click="saveTelegram">保存 Telegram 配置</button>
              <button class="btn btn-sm" @click="testTg">发送测试消息</button>
            </div>
          </div>
        </div>

        <div class="sub-mod">
          <div class="sub-head">
            邮件（SMTP）
            <span class="st-tag" :class="settings.notif.smtp?.configured ? 'st-ok' : 'st-off'">
              {{ settings.notif.smtp?.configured ? '● 已配置' : '未配置' }}
            </span>
          </div>
          <div class="sub-body">
            <div class="set-row">
              <div class="field"><label class="lbl">SMTP 主机</label><input v-model="smtpHost" class="input mono" placeholder="smtp.example.com"></div>
              <div class="field"><label class="lbl">SMTP 端口</label><input v-model="smtpPort" class="input mono" placeholder="465 / 587 / 25"></div>
            </div>
            <div class="set-row">
              <div class="field"><label class="lbl">SMTP 账号</label><input v-model="smtpUser" class="input" placeholder="留空 = 保持原值"></div>
              <div class="field"><label class="lbl">SMTP 密码</label><input v-model="smtpPass" class="input" type="password" placeholder="留空 = 保持原值（仅写不读）"></div>
              <div class="field"><label class="lbl">收件人（逗号分隔）</label><input v-model="smtpTo" class="input" placeholder="you@example.com"></div>
            </div>
            <div class="set-row">
              <div class="field">
                <label class="lbl">加密方式</label>
                <select v-model="smtpSecure" class="input mono">
                  <option value="auto">自动（465=TLS / 587=STARTTLS / 25=明文）</option>
                  <option value="tls">强制 TLS（SSL）</option>
                  <option value="plain">明文（不加密）</option>
                </select>
              </div>
            </div>
            <div v-if="settings.notif.smtp?.configured" class="readonly-val" style="margin-bottom:12px">
              当前配置：<span class="mono">{{ settings.notif.smtp.host }}:{{ settings.notif.smtp.port }}</span> · 账号 <span class="mono">{{ settings.notif.smtp.username }}</span> · 收件人 <span class="mono">{{ settings.notif.smtp.to }}</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm btn-primary" @click="saveSmtp">保存 SMTP 配置</button>
              <button class="btn btn-sm" @click="testSmtp">发送测试邮件</button>
            </div>
          </div>
        </div>

        <span class="hint">凭证经<b>加密后存储</b>于本地数据库（AES-256 加密，主密钥由部署 Secret 提供），不以明文保存；密码类字段仅写不读。未配置的通道自动跳过通知。</span>
      </div>
    </div>

    <!-- 清理兜底 -->
    <div class="set-card">
      <div class="set-head"><h3>清理兜底</h3><span class="st" style="color:var(--ink-3)">默认关闭，谨慎开启</span></div>
      <div class="set-body">
        <div class="set-row">
          <div class="field">
            <label class="lbl" style="display:flex;align-items:center;gap:8px">
              <span class="switch">
                <input type="checkbox" :checked="settings.cleanup.prune_enabled" @change="settings.cleanup.prune_enabled = $event.target.checked">
                <span class="slider"></span>
              </span>
              执行后运行 <span class="mono" style="color:var(--accent)">docker image prune</span> 深度清理
            </label>
            <div class="hint">删除失败的悬空镜像兜底清理；开启后每次任务结束自动执行</div>
          </div>
          <div class="field">
            <label class="lbl">定时重启容器兜底（cron，空 = 关闭）</label>
            <input v-model="restartCron" class="input mono" placeholder="0 4 1 * *（每月 1 日 04:00）">
            <div class="hint">按 cron 通过宿主 Docker 重启本容器（配合 compose restart: unless-stopped）</div>
          </div>
        </div>
        <div class="set-actions">
          <button class="btn btn-sm btn-primary" @click="saveCleanup">保存兜底配置</button>
          <button class="btn btn-sm" @click="runCleanup">立即执行清理</button>
          <span class="hint" style="flex-basis:100%">「立即执行清理」按当前开关状态立即执行一次深度清理，不等待下次任务（未开启 prune 时将被拒绝）。</span>
        </div>
      </div>
    </div>
  </div>
</template>
