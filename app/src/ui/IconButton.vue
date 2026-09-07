<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    variant?: 'plain' | 'outline';
    active?: boolean;
    size?: number;
    /** Inert control ("Coming soon"): `aria-disabled` plus this tooltip, keeping the reference look (no dimming). */
    disabledHint?: string;
  }>(),
  { variant: 'plain', active: false, size: 40, disabledHint: undefined },
);
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="disabledHint ?? label"
    :aria-disabled="disabledHint ? 'true' : undefined"
    :aria-pressed="variant === 'outline' ? active : undefined"
    class="inline-flex shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
    :class="[
      variant === 'plain'
        ? 'text-text-2'
        : active
          ? 'border border-border bg-primary-soft text-primary'
          : 'border border-border bg-bg text-text-2',
      disabledHint ? 'cursor-default' : variant === 'plain' ? 'hover:bg-bg-muted' : !active && 'hover:bg-hover-row',
    ]"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <slot />
  </button>
</template>
