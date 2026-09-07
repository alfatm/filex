<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AlertCircle, Check, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import { IconButton, ProgressBar } from '@/ui';
import { useUploadStore } from './uploadStore';

const { t } = useI18n();
const { formatSize } = useFormat();
const uploads = useUploadStore();
</script>

<template>
  <!-- Spec §7: bottom-right card w 360 with per-file progress. -->
  <section
    v-if="uploads.open"
    :aria-label="t('upload.title', { done: uploads.doneCount, total: uploads.items.length })"
    class="fixed bottom-6 right-6 z-30 w-[360px] overflow-hidden rounded-lg border border-border bg-bg shadow-menu"
  >
    <header class="flex h-12 items-center border-b border-border pl-4 pr-1">
      <span class="flex-1 text-15 font-medium leading-none" aria-live="polite">
        <!-- A failure outranks the count: "3 of 3" over a row that never arrived would be a lie. -->
        <template v-if="uploads.failedCount">{{ t('upload.failed', uploads.failedCount) }}</template>
        <template v-else-if="uploads.doneCount === uploads.items.length">{{ t('upload.done', uploads.items.length) }}</template>
        <template v-else>{{ t('upload.title', { done: uploads.doneCount, total: uploads.items.length }) }}</template>
      </span>
      <IconButton :label="t('upload.close')" :size="36" class="text-text-3" @click="uploads.clear()"><X :size="18" /></IconButton>
    </header>
    <ul class="max-h-[240px] overflow-y-auto py-1">
      <li v-for="item in uploads.items" :key="item.id" class="flex h-12 items-center px-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center">
            <span class="min-w-0 flex-1 truncate-safe text-15 leading-none">{{ item.name }}</span>
            <span class="ml-3 shrink-0 text-13 leading-none text-text-3">{{ formatSize(item.size) }}</span>
          </div>
          <ProgressBar class="mt-2" :value="item.progress" :max="100" :label="item.name" />
        </div>
        <!-- A stalled bar says nothing; the row has to say the transfer is over and did not work. -->
        <span
          v-if="item.failed"
          class="ml-3 flex h-6 w-6 shrink-0 items-center justify-center text-danger"
          role="img"
          :aria-label="t('upload.failedItem')"
        >
          <AlertCircle :size="18" />
        </span>
        <span v-else class="ml-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" :class="item.done ? 'bg-success text-white' : 'text-transparent'">
          <Check :size="14" :stroke-width="3" />
        </span>
      </li>
    </ul>
  </section>
</template>
