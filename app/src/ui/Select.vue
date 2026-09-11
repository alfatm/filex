<script setup lang="ts" generic="T extends string">
import type { Component } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    /** A disabled option stays visible and greyed: it says the destination exists but is not offered. */
    options: { value: T; label: string; disabled?: boolean }[];
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
  <span class="relative flex h-control-md items-center" :style="{ width: width ? `${width}px` : undefined }">
    <component :is="icon" v-if="icon" :size="16" class="pointer-events-none absolute left-2.5 text-text-3" />
    <select
      v-model="model"
      :aria-label="label"
      class="h-full w-full appearance-none rounded-md border border-border bg-bg leading-none text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      :class="[icon ? 'pl-[38px]' : dense ? 'pl-2' : 'pl-2.5', dense ? 'pr-6 text-11.5' : 'pr-8 text-13']"
    >
      <option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option>
    </select>
    <ChevronDown :size="16" class="pointer-events-none absolute text-text-3" :class="dense ? 'right-1.5' : 'right-3'" />
  </span>
</template>
