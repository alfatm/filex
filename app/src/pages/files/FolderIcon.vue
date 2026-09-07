<script setup lang="ts">
import { Users } from 'lucide-vue-next';

withDefaults(defineProps<{ width?: number; height?: number; shared?: boolean }>(), {
  width: 36,
  height: 30,
  shared: false,
});
</script>

<template>
  <span class="relative inline-flex shrink-0 text-folder" :style="{ width: `${width}px`, height: `${height}px` }">
    <svg :width="width" :height="height" viewBox="0 0 36 30" aria-hidden="true">
      <path
        d="M2 5a3 3 0 0 1 3-3h8.2a3 3 0 0 1 2.1.9L18 5.5h13a3 3 0 0 1 3 3V25a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z"
        fill="currentColor"
      />
    </svg>
    <Users
      v-if="shared"
      class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[35%] text-white"
      :size="Math.round(height * 0.5)"
      :stroke-width="2.25"
    />
  </span>
</template>
