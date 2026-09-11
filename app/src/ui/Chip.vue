<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next';

/** `disabledHint` marks an inert chip ("Coming soon"): `aria-disabled` plus the tooltip, no dimming (spec look). */
defineProps<{ label: string; width?: number; disabledHint?: string; active?: boolean }>();
</script>

<template>
  <button
    type="button"
    :aria-disabled="disabledHint ? 'true' : undefined"
    :title="disabledHint"
    class="inline-flex h-control-sm shrink-0 items-center justify-between rounded border px-2.5 text-12 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
    :class="[
      active ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-bg text-text',
      disabledHint ? 'cursor-default' : 'hover:bg-hover-row',
    ]"
    :style="width && !active ? { width: `${width}px` } : undefined"
  >
    <span>{{ label }}</span>
    <ChevronDown :size="14" class="ml-1" :class="active ? 'text-primary' : 'text-text-3'" />
  </button>
</template>
