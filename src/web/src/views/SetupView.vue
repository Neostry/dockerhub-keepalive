<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import LogoIcon from '@/components/LogoIcon.vue'
import { validateUsername, validatePassword } from '@/utils/validate'

const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()

const username = ref('')
const password = ref('')
const password2 = ref('')
const errMsg = ref('')
const submitting = ref(false)

async function submit() {
  errMsg.value = ''
  const u = username.value.trim()
  const p = password.value
  if (!validateUsername(u)) { errMsg.value = '用户名至少 3 个字符'; return }
  if (!validatePassword(p)) { errMsg.value = '密码需至少 8 位且同时包含字母与数字'; return }
  if (p !== password2.value) { errMsg.value = '两次输入的密码不一致'; return }
  submitting.value = true
  try {
    await auth.setupAccount(u, p)
    ui.toast('账号创建成功，请使用刚设置的账号登录')
    router.push('/login')
  } catch (e) {
    errMsg.value = e.message
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
      <p class="auth-sub" style="margin-top:10px">首次使用，请创建管理员账号（无默认密码）</p>
      <div v-if="errMsg" class="auth-err show">{{ errMsg }}</div>
      <div class="field">
        <label class="lbl">用户名</label>
        <input v-model="username" class="input" placeholder="例如 admin" autocomplete="username" @keyup.enter="submit">
      </div>
      <div class="field">
        <label class="lbl">密码（至少 8 位，含字母与数字）</label>
        <input v-model="password" class="input" type="password" placeholder="••••••••" autocomplete="new-password" @keyup.enter="submit">
      </div>
      <div class="field">
        <label class="lbl">确认密码</label>
        <input v-model="password2" class="input" type="password" placeholder="再次输入密码" autocomplete="new-password" @keyup.enter="submit">
      </div>
      <button class="btn btn-primary" :disabled="submitting" @click="submit">创建账号并开始</button>
      <div class="auth-note"><b>安全说明：</b>密码将以 Argon2 哈希存储，凭据仅存于服务端 SQLite。</div>
    </div>
  </div>
</template>
