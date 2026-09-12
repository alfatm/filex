<script setup lang="ts">
import { computed } from 'vue';
import type { MatchRange } from '@/data/types';

const props = defineProps<{ text: string; ranges: MatchRange[] }>();

/** Splits the text into plain and highlighted runs; overlapping ranges are merged, out-of-bounds ends clamped. */
const parts = computed(() => {
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const range of [...props.ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(range.start, at);
    const end = Math.min(range.end, props.text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: props.text.slice(at, start), mark: false });
    out.push({ text: props.text.slice(start, end), mark: true });
    at = end;
  }
  if (at < props.text.length) out.push({ text: props.text.slice(at), mark: false });
  return out;
});
</script>

<template>
  <span>
    <template v-for="(part, i) in parts" :key="i">
      <mark v-if="part.mark" class="rounded-[3px] bg-highlight text-current">{{ part.text }}</mark>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>
