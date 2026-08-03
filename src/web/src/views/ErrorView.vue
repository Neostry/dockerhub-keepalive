<script setup>
// 后端不可达提示页（网络层错误，非业务错误）
</script>

<template>
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">
        <div style="text-align:center;width:100%">
          <div class="auth-title" style="margin:0">无法连接后端服务</div>
          <div class="auth-slogan" style="text-align:center;margin-top:6px">请确认服务已启动后刷新页面</div>
        </div>
      </div>
      <p class="auth-sub" style="margin-top:16px">后端 API（/api）不可达。可能原因：服务未启动、端口未监听或网络异常。</p>
      <button class="btn btn-primary" @click="$router.go(0)">重新加载</button>
    </div>
  </div>
</template>
