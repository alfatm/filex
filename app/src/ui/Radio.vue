<script setup lang="ts" generic="T extends string">
defineProps<{ value: T; label: string }>();
const model = defineModel<T>({ required: true });
</script>

<template>
  <label class="flex cursor-default items-center gap-2 text-15 leading-none text-text">
    <input v-model="model" type="radio" :value="value" class="peer sr-only" />
    <span
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border-hover bg-bg peer-checked:border-primary peer-checked:[&>span]:opacity-100 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-ring"
    >
      <span class="h-2.5 w-2.5 rounded-full bg-primary opacity-0" />
    </span>
    <span>{{ label }}</span>
  </label>
</template>
