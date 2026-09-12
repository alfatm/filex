<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    variant?: 'plain' | 'outline';
    active?: boolean;
    /**
     * Hit area in px. The glyph inside is 16-18; this is the box that takes the click, and stays ≥ 28.
     * ⚠ Under a coarse pointer `.touch-target` raises it to 44 whatever is passed here — see main.css.
     */
    size?: number;
    /** Inert control ("Coming soon"): `aria-disabled` plus this tooltip, keeping the reference look (no dimming). */
    disabledHint?: string;
  }>(),
  { variant: 'plain', active: false, size: 34, disabledHint: undefined },
);
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="disabledHint ?? label"
    :aria-disabled="disabledHint ? 'true' : undefined"
    :aria-pressed="variant === 'outline' ? active : undefined"
    class="touch-target inline-flex shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
    :class="[
      variant === 'plain'
        ? 'text-text-2'
        : active
          ? 'border border-border bg-primary-soft text-primary-strong'
          : 'border border-border bg-bg text-text-2',
      disabledHint ? 'cursor-default' : variant === 'plain' ? 'hover:bg-bg-muted' : !active && 'hover:bg-hover-row',
    ]"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <slot />
  </button>
</template>
