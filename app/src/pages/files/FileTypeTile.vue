<script setup lang="ts">
import type { Component } from 'vue';
import { Code2, FileText, Figma, Image, Play, Table2, File } from 'lucide-vue-next';
import type { FileType } from '@/data/types';

withDefaults(defineProps<{ type: FileType; size?: number }>(), { size: 28 });

// Colours live in tokens.css as --c-tile-<type>.
const icons = {
  md: FileText,
  image: Image,
  ts: Code2,
  pdf: FileText,
  fig: Figma,
  csv: Table2,
  mp4: Play,
  other: File,
} as const satisfies Record<FileType, Component>;
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-sm text-white"
    :style="{ width: `${size}px`, height: `${size}px`, background: `var(--c-tile-${type})` }"
  >
    <component :is="icons[type]" :size="Math.round(size * 0.57)" :stroke-width="2" />
  </span>
</template>
