<script setup lang="ts">
withDefaults(defineProps<{ initial: string; size?: number; src?: string }>(), { size: 28, src: '' });
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-soft text-11.5 font-semibold leading-none text-primary-strong"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <!-- A picture that fails to load falls back to nothing, not to a broken-image glyph; the initial is the default. -->
    <img v-if="src" :src="src" alt="" class="h-full w-full object-cover" />
    <template v-else>{{ initial }}</template>
  </span>
</template>
