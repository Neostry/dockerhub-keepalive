<script setup>
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="toast" :class="{ show: ui.toastShow }" role="status" aria-live="polite">
    <div class="toast-inner">{{ ui.toastMsg }}</div>
  </div>
</template>
