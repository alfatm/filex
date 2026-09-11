<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'outline' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
    type?: 'button' | 'submit';
  }>(),
  { variant: 'primary', size: 'md', type: 'button' },
);

const variants = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  outline: 'bg-bg border border-border text-text hover:bg-hover-row',
  ghost: 'text-text hover:bg-bg-muted',
} as const;

// The two control sizes from tokens.css: `md` is the default control, `lg` the primary call to action (the New
// button). Both shrank with the density pass; `lg` is 40px, not a button a modal's footer would look small beside.
const sizes = {
  sm: 'h-control-sm px-2.5 text-13 rounded',
  md: 'h-control-md px-3.5 text-13 rounded',
  lg: 'h-control-lg px-4 text-13 rounded-md',
} as const;
</script>

<template>
  <button
    :type="type"
    class="inline-flex items-center justify-center gap-2 font-medium leading-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:pointer-events-none disabled:opacity-50"
    :class="[variants[variant], sizes[size]]"
  >
    <slot />
  </button>
</template>
