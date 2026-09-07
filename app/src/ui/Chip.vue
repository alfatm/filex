<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next';

/** `disabledHint` marks an inert chip ("Coming soon"): `aria-disabled` plus the tooltip, no dimming (spec look). */
defineProps<{ label: string; width?: number; disabledHint?: string }>();
</script>

<template>
  <button
    type="button"
    :aria-disabled="disabledHint ? 'true' : undefined"
    :title="disabledHint"
    class="inline-flex h-[38px] shrink-0 items-center justify-between rounded-full border border-border bg-bg px-[18px] text-15 leading-none text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
    :class="disabledHint ? 'cursor-default' : 'hover:bg-hover-row'"
    :style="width ? { width: `${width}px` } : undefined"
  >
    <span>{{ label }}</span>
    <ChevronDown :size="16" class="ml-1.5 text-text-3" />
  </button>
</template>
