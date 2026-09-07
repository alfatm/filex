<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'outline' | 'ghost';
    size?: 'md' | 'lg';
    type?: 'button' | 'submit';
  }>(),
  { variant: 'primary', size: 'md', type: 'button' },
);

const variants = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  outline: 'bg-bg border border-border text-text hover:bg-hover-row',
  ghost: 'text-text hover:bg-bg-muted',
} as const;

const sizes = {
  md: 'h-10 px-4 text-15 rounded-md',
  lg: 'h-[52px] px-5 text-18 rounded-lg',
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
