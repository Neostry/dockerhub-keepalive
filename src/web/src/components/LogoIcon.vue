<script setup>
// 产品 logo：集装箱（Docker 意象）+ 心跳线（保活意象）
// 设计令牌配色：天空蓝 #3EC3F0 → 青玉 #2DD4BF 渐变
import { useId } from 'vue'

defineProps({
  size: { type: [Number, String], default: 32 }
})
const gid = `dk-grad-${useId()}`
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 48 48" fill="none"
    xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Docker Keepalive 图标"
  >
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3EC3F0"/>
        <stop offset="1" stop-color="#2DD4BF"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="13" :fill="`url(#${gid})`"/>
    <rect x="2.75" y="2.75" width="42.5" height="42.5" rx="11.75" stroke="rgba(255,255,255,.22)" stroke-width="1.5"/>
    <!-- 集装箱 -->
    <path d="M15 19.2l9-4.7 9 4.7v9.6l-9 4.7-9-4.7v-9.6z" stroke="#062033" stroke-width="2" stroke-linejoin="round" fill="rgba(6,32,51,.10)"/>
    <path d="M15 19.2l9 4.7 9-4.7M24 23.9v9.6" stroke="#062033" stroke-width="2" stroke-linejoin="round"/>
    <!-- 心跳线（保活） -->
    <path d="M15.5 31.8h4l2-4.6 2.6 7.2 2-3.8 1.2-2.6h5.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</template>
