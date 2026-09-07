<script setup lang="ts">
withDefaults(defineProps<{ width?: number }>(), { width: 320 });
</script>

<template>
  <aside
    class="flex h-full shrink-0 flex-col overflow-y-auto border-l border-border bg-bg px-[22px] py-5"
    :style="{ width: `${width}px` }"
  >
    <slot />
  </aside>
</template>
