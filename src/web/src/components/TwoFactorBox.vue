<script setup>
import { ref } from 'vue'
import QRCode from 'qrcode'
import * as api from '@/api'
import { useUiStore } from '@/stores/ui'
import { useStatusStore } from '@/stores/status'
import { validateTotp } from '@/utils/validate'

const ui = useUiStore()
const status = useStatusStore()

// mode：off 未开启 / binding 待绑定（已获取密钥未 enable）/ on 已开启
const mode = ref(status.totpEnabled ? 'on' : 'off')
const secret = ref('')
const otpauth = ref('')
const qrUrl = ref('')
const totpInput = ref('')
const busy = ref(false)
const showDisable = ref(false)
const disableTotp = ref('')
const disablePass = ref('')

const modeText = { off: '2FA 未开启', binding: '2FA 待绑定', on: '2FA 已开启' }
const modeColor = { off: 'var(--ink-3)', binding: 'var(--warn)', on: 'var(--ok)' }

async function startBind() {
  busy.value = true
  try {
    const r = await api.twofaSetup()
    secret.value = r.secret
    otpauth.value = r.otpauth_uri
    qrUrl.value = await QRCode.toDataURL(r.otpauth_uri, { width: 220, margin: 1 })
    mode.value = 'binding'
    totpInput.value = ''
  } catch (e) {
    ui.toast(e.message)
    if (/已开启|已启用|enabled/i.test(e.message || '')) mode.value = 'on'
  } finally {
    busy.value = false
  }
}

async function confirmEnable() {
  if (!validateTotp(totpInput.value)) { ui.toast('请输入 6 位动态码'); return }
  busy.value = true
  try {
    await api.twofaEnable({ totp: totpInput.value.trim() })
    mode.value = 'on'
    status.totpEnabled = true
    ui.toast('2FA 已开启，登录时将校验动态码')
    reset()
  } catch (e) { ui.toast(e.message) } finally { busy.value = false }
}

/** 重新生成：校验旧动态码 → 返回新密钥 → 再次 enable 完成切换 */
async function regenerate() {
  if (!validateTotp(totpInput.value)) { ui.toast('请输入当前 6 位动态码'); return }
  busy.value = true
  try {
    const r = await api.twofaRegenerate({ totp: totpInput.value.trim() })
    secret.value = r.secret
    otpauth.value = r.otpauth_uri
    qrUrl.value = await QRCode.toDataURL(r.otpauth_uri, { width: 220, margin: 1 })
    mode.value = 'binding'
    totpInput.value = ''
    ui.toast('密钥已重新生成，请输入新动态码完成绑定')
  } catch (e) { ui.toast(e.message) } finally { busy.value = false }
}

async function disable() {
  const t = disableTotp.value.trim()
  const p = disablePass.value
  if (!t && !p) { ui.toast('请输入动态码或当前密码以确认关闭'); return }
  busy.value = true
  try {
    await api.twofaDisable(t ? { totp: t } : { password: p })
    mode.value = 'off'
    status.totpEnabled = false
    showDisable.value = false
    ui.toast('2FA 已关闭')
    reset()
  } catch (e) { ui.toast(e.message) } finally { busy.value = false }
}

function reset() {
  secret.value = ''
  otpauth.value = ''
  qrUrl.value = ''
  totpInput.value = ''
  disableTotp.value = ''
  disablePass.value = ''
}

async function copySecret() {
  try {
    await navigator.clipboard.writeText(secret.value)
    ui.toast('密钥已复制')
  } catch {
    ui.toast('复制失败，请手动复制密钥')
  }
}
</script>

<template>
  <div>
    <div class="set-actions" style="margin-bottom:6px">
      <button v-if="mode === 'off'" class="btn btn-sm" :disabled="busy" @click="startBind">开启 2FA</button>
      <template v-if="mode === 'on'">
        <button class="btn btn-sm" :disabled="busy" @click="showDisable = !showDisable">{{ showDisable ? '取消关闭' : '关闭 2FA' }}</button>
        <button class="btn btn-sm" :disabled="busy" @click="regenerate">重新生成密钥</button>
        <input v-model="totpInput" class="input mono" style="max-width:140px" placeholder="当前 6 位动态码" maxlength="6" inputmode="numeric">
      </template>
    </div>

    <!-- 待绑定：展示密钥 + 二维码 + 绑定输入 -->
    <div v-if="mode === 'binding'" class="qr-box">
      <img :src="qrUrl" alt="2FA 二维码" width="110" height="110">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;color:var(--ink)">使用验证器 App（Google Authenticator / Authy）扫码绑定</div>
        <div class="qr-key">{{ otpauth }}</div>
        <div class="qr-key"><span class="sec">密钥（Secret）：{{ secret }}</span></div>
        <div class="hint">二维码被浏览器插件拦截时可手动复制密钥到验证器 / 密码管理器。密钥仅展示一次。</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-sm" @click="copySecret">复制密钥</button>
          <input v-model="totpInput" class="input mono" style="max-width:140px" placeholder="6 位动态码" maxlength="6" inputmode="numeric">
          <button class="btn btn-sm btn-primary" :disabled="busy" @click="confirmEnable">确认开启</button>
          <button class="btn btn-sm btn-ghost" :disabled="busy" @click="reset(); mode = status.totpEnabled ? 'on' : 'off'">取消</button>
        </div>
      </div>
    </div>

    <!-- 关闭 2FA 确认（动态码或当前密码二选一） -->
    <div v-if="mode === 'on' && showDisable" class="qr-box">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;color:var(--ink)">关闭 2FA 需校验：输入当前动态码，或输入当前密码</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="min-width:150px;flex:1">
            <label class="lbl">动态码</label>
            <input v-model="disableTotp" class="input mono" placeholder="6 位数字" maxlength="6" inputmode="numeric">
          </div>
          <div class="field" style="min-width:150px;flex:1">
            <label class="lbl">或当前密码</label>
            <input v-model="disablePass" class="input" type="password" placeholder="••••••••">
          </div>
          <button class="btn btn-sm btn-danger" :disabled="busy" @click="disable">确认关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>
