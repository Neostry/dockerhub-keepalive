<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import LogoIcon from '@/components/LogoIcon.vue'
import { validateTotp } from '@/utils/validate'

const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()

const username = ref('')
const password = ref('')
const totp = ref('')
const totpMode = ref(false)   // 两段式登录：后端要求动态码时出现
const errMsg = ref('')
const submitting = ref(false)

async function submit() {
  errMsg.value = ''
  const u = username.value.trim()
  const p = password.value
  if (!u || !p) { errMsg.value = '请输入用户名与密码'; return }
  if (totpMode.value && !validateTotp(totp.value)) { errMsg.value = '请输入 6 位动态码'; return }
  submitting.value = true
  try {
    const r = await auth.login({ username: u, password: p, totp: totpMode.value ? totp.value.trim() : undefined })
    if (r.needTotp) {
      totpMode.value = true
      errMsg.value = ''
      ui.toast('该账号已开启 2FA，请输入动态码')
      return
    }
    ui.toast('登录成功')
    router.push('/')
  } catch (e) {
    // 契约兼容两种两段式形态：400 + code=TOTP_REQUIRED / 200 + requires_totp
    const needTotp = e.data && (e.data.code === 'TOTP_REQUIRED' || e.data.requires_totp)
    if (needTotp || /动态码|2FA/.test(e.message || '')) {
      totpMode.value = true
      errMsg.value = '该账号已开启 2FA，请输入动态码'
    } else {
      errMsg.value = e.message || '用户名或密码错误'
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">
        <LogoIcon :size="40" />
        <div style="line-height:1.2">
          <div class="auth-title" style="margin:0">Docker Keepalive</div>
          <div class="auth-slogan">镜像保活 · 零人工干预</div>
        </div>
      </div>
      <p class="auth-sub" style="margin-top:10px">登录以管理您的保活任务</p>
      <div v-if="errMsg" class="auth-err show">{{ errMsg }}</div>
      <div class="field">
        <label class="lbl">用户名</label>
        <input v-model="username" class="input" placeholder="admin" autocomplete="username" @keyup.enter="submit">
      </div>
      <div class="field">
        <label class="lbl">密码</label>
        <input v-model="password" class="input" type="password" placeholder="••••••••" autocomplete="current-password" @keyup.enter="submit">
      </div>
      <div v-show="totpMode" class="field">
        <label class="lbl">2FA 动态码（验证器 App）</label>
        <input v-model="totp" class="input mono" placeholder="6 位数字" inputmode="numeric" maxlength="6" autocomplete="one-time-code" @keyup.enter="submit">
      </div>
      <button class="btn btn-primary" :disabled="submitting" @click="submit">登录</button>
      <div class="auth-note"><b>安全说明：</b>错误凭据统一提示"用户名或密码错误"；连续失败 5 次将临时锁定 15 分钟。</div>
    </div>
  </div>
</template>
