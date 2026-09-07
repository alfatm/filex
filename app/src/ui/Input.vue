<script setup lang="ts">
import { ref, type Component } from 'vue';

withDefaults(
  defineProps<{
    placeholder?: string;
    icon?: Component;
    height?: number;
    width?: number;
    type?: 'text' | 'search' | 'number' | 'password';
    label?: string;
  }>(),
  { placeholder: '', icon: undefined, height: 40, width: undefined, type: 'text', label: undefined },
);
// `type="number"` inputs hand v-model a number (Vue casts), every other type a string.
const model = defineModel<string | number>({ required: true });
const emit = defineEmits<{ enter: [] }>();
const input = ref<HTMLInputElement>();
defineExpose({ focus: () => input.value?.focus(), el: input });
</script>

<template>
  <label
    class="flex items-center rounded-md border border-border bg-bg px-3 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
    :style="{ height: `${height}px`, width: width ? `${width}px` : undefined }"
  >
    <component :is="icon" v-if="icon" :size="18" class="mr-2.5 shrink-0 text-text-3" />
    <input
      ref="input"
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      :aria-label="label"
      class="min-w-0 flex-1 bg-transparent text-15 leading-none text-text placeholder:text-text-3 focus:outline-none"
      @keydown.enter.prevent="emit('enter')"
    />
  </label>
</template>
