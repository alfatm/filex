<script setup lang="ts" generic="T extends string">
defineProps<{ options: { value: T; label: string }[]; label: string }>();
const model = defineModel<T>({ required: true });

// Arrows move and select, as in the listing's view toggle; Tab reaches only the checked segment.
function step(options: { value: T }[], delta: number) {
  const next = options[(options.findIndex((o) => o.value === model.value) + delta + options.length) % options.length];
  if (next) model.value = next.value;
}
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="label"
    class="flex h-9 overflow-hidden rounded-md border border-border"
    @keydown.left.prevent="step(options, -1)"
    @keydown.right.prevent="step(options, 1)"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="model === option.value"
      :tabindex="model === option.value ? 0 : -1"
      class="flex-1 px-3 text-11.5 font-medium leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-ring"
      :class="model === option.value ? 'bg-primary-soft text-primary' : 'text-text-2 hover:bg-hover-row'"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>
