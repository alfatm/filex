<script setup lang="ts">
defineProps<{ value: number; max: number; width?: number; label?: string }>();
</script>

<template>
  <div
    role="progressbar"
    :aria-valuenow="value"
    :aria-valuemax="max"
    :aria-label="label"
    class="h-1.5 overflow-hidden rounded-full bg-border"
    :style="width ? { width: `${width}px` } : undefined"
  >
    <div class="h-full rounded-full bg-primary" :style="{ width: `${Math.min(100, (value / max) * 100)}%` }" />
  </div>
</template>
