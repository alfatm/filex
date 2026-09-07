<script setup lang="ts" generic="T extends string">
import type { Component } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    options: { value: T; label: string }[];
    icon?: Component;
    width?: number;
    label?: string;
    /** Tighter padding and 14px text for narrow controls (spec §5 size row). */
    dense?: boolean;
  }>(),
  { icon: undefined, width: undefined, label: undefined, dense: false },
);
const model = defineModel<T>({ required: true });
</script>

<template>
  <span class="relative flex h-10 items-center" :style="{ width: width ? `${width}px` : undefined }">
    <component :is="icon" v-if="icon" :size="18" class="pointer-events-none absolute left-3 text-text-3" />
    <select
      v-model="model"
      :aria-label="label"
      class="h-full w-full appearance-none rounded-md border border-border bg-bg leading-none text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      :class="[icon ? 'pl-[42px]' : dense ? 'pl-2.5' : 'pl-3', dense ? 'pr-6 text-14' : 'pr-9 text-15']"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <ChevronDown :size="16" class="pointer-events-none absolute text-text-3" :class="dense ? 'right-1.5' : 'right-3'" />
  </span>
</template>
