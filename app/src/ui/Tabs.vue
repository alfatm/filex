<script setup lang="ts" generic="T extends string">
const props = defineProps<{ tabs: { id: T; label: string }[] }>();
const model = defineModel<T>({ required: true });

function step(delta: 1 | -1, event: KeyboardEvent) {
  const index = props.tabs.findIndex((tab) => tab.id === model.value);
  const next = props.tabs[(index + delta + props.tabs.length) % props.tabs.length];
  model.value = next.id;
  (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
}
</script>

<template>
  <div role="tablist" class="flex border-b border-border" @keydown.left.prevent="step(-1, $event)" @keydown.right.prevent="step(1, $event)">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :data-tab="tab.id"
      :aria-selected="model === tab.id"
      :tabindex="model === tab.id ? 0 : -1"
      class="-mb-px flex h-[46px] flex-1 items-center justify-center border-b-2 text-16 font-medium leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-ring"
      :class="model === tab.id ? 'border-primary text-primary' : 'border-transparent text-text-3 hover:text-text'"
      @click="model = tab.id"
    >
      {{ tab.label }}
    </button>
  </div>
</template>
