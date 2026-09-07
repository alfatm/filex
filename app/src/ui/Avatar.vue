<script setup lang="ts">
withDefaults(defineProps<{ initial: string; size?: number }>(), { size: 36 });
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full bg-primary-soft text-15 font-semibold leading-none text-primary"
    :style="{ width: `${size}px`, height: `${size}px` }"
    >{{ initial }}</span>
</template>
