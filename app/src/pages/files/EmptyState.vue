<script setup lang="ts">
import type { Component } from 'vue';

/** Centred icon 40 gray, title 13/500, hint 11.5 gray. */
defineProps<{ icon: Component; title: string; hint?: string }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-14 text-center">
    <component :is="icon" :size="40" :stroke-width="1.5" class="text-text-3" />
    <p class="mt-3 text-13 font-medium leading-none">{{ title }}</p>
    <p v-if="hint" class="mt-2 text-11.5 leading-none text-text-3">{{ hint }}</p>
    <!-- Optional action, e.g. "Clear filters" when the chips hid everything. -->
    <div v-if="$slots.default" class="mt-4"><slot /></div>
  </div>
</template>
