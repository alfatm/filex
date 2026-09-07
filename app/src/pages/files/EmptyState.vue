<script setup lang="ts">
import type { Component } from 'vue';

/** Centred icon 48 gray, title 16/500, hint 14 gray. */
defineProps<{ icon: Component; title: string; hint?: string }>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-20 text-center">
    <component :is="icon" :size="48" :stroke-width="1.5" class="text-text-3" />
    <p class="mt-4 text-16 font-medium leading-none">{{ title }}</p>
    <p v-if="hint" class="mt-2 text-14 leading-none text-text-3">{{ hint }}</p>
    <!-- Optional action, e.g. "Clear filters" when the chips hid everything. -->
    <div v-if="$slots.default" class="mt-5"><slot /></div>
  </div>
</template>
