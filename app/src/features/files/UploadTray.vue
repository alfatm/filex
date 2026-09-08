<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertCircle, Check, RotateCcw, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import { IconButton, ProgressBar } from '@/ui';
import { useUploadStore } from './uploadStore';

const { t } = useI18n();
const { formatSize } = useFormat();
const uploads = useUploadStore();

/**
 * Resuming needs the bytes again: a reload leaves the server holding a staged upload and this page holding no
 * `File` at all. So the person picks the same file once more, and the store refuses anything whose name or size
 * does not match what the session was begun for.
 */
const picker = ref<HTMLInputElement>();
const resuming = ref<number | null>(null);

function askForFile(id: number) {
  resuming.value = id;
  picker.value?.click();
}

async function onPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const id = resuming.value;
  input.value = '';
  resuming.value = null;
  if (!file || id === null) return;
  if (!(await uploads.resume(id, file))) mismatch.value = id;
}

/** Set when the picked file was not the one the transfer was begun for; cleared as soon as another is picked. */
const mismatch = ref<number | null>(null);
</script>

<template>
  <!-- Spec §7: bottom-right card w 360 with per-file progress. -->
  <section
    v-if="uploads.open"
    :aria-label="t('upload.title', { done: uploads.doneCount, total: uploads.items.length })"
    class="w-[360px] overflow-hidden rounded-lg border border-border bg-bg shadow-menu"
  >
    <header class="flex h-12 items-center border-b border-border pl-4 pr-1">
      <span class="flex-1 text-15 font-medium leading-none" aria-live="polite">
        <!-- A failure outranks the count: "3 of 3" over a row that never arrived would be a lie. -->
        <template v-if="uploads.failedCount">{{ t('upload.failed', uploads.failedCount) }}</template>
        <template v-else-if="uploads.interruptedCount">{{ t('upload.interrupted', uploads.interruptedCount) }}</template>
        <template v-else-if="uploads.doneCount === uploads.items.length">{{ t('upload.done', uploads.items.length) }}</template>
        <template v-else>{{ t('upload.title', { done: uploads.doneCount, total: uploads.items.length }) }}</template>
      </span>
      <IconButton :label="t('upload.close')" :size="36" class="text-text-3" @click="uploads.clear()"><X :size="18" /></IconButton>
    </header>
    <ul class="max-h-[240px] overflow-y-auto py-1">
      <li v-for="item in uploads.items" :key="item.id" class="flex min-h-12 items-center px-4 py-1">
        <div class="min-w-0 flex-1">
          <div class="flex items-center">
            <span class="min-w-0 flex-1 truncate-safe text-15 leading-none">{{ item.name }}</span>
            <span class="ml-3 shrink-0 text-13 leading-none text-text-3">{{ formatSize(item.size) }}</span>
          </div>
          <ProgressBar class="mt-2" :value="item.progress" :max="100" :label="item.name" />
          <!-- An interrupted transfer is the only row with something to offer, so it says what and how far. -->
          <p v-if="item.state === 'interrupted'" class="mt-1 text-13 leading-none text-text-3">
            {{ t('upload.stoppedAt', { percent: Math.floor(item.progress) }) }}
            <button type="button" class="ml-2 text-primary hover:underline" @click="askForFile(item.id)">{{ t('upload.resume') }}</button>
            <button type="button" class="ml-2 text-text-3 hover:underline" @click="uploads.discard(item.id)">{{ t('upload.discard') }}</button>
          </p>
          <p v-if="mismatch === item.id" class="mt-1 text-13 leading-none text-danger">{{ t('upload.wrongFile') }}</p>
          <p v-else-if="item.state === 'cancelled'" class="mt-1 text-13 leading-none text-text-3">{{ t('upload.cancelled') }}</p>
        </div>
        <!-- Stopping one transfer leaves the others alone, so the control is per row. -->
        <IconButton
          v-if="item.state === 'running'"
          :label="t('upload.cancelItem', { name: item.name })"
          :size="24"
          class="ml-3 shrink-0 text-text-3"
          @click="uploads.cancel(item.id)"
        >
          <X :size="16" />
        </IconButton>
        <!-- A stalled bar says nothing; the row has to say the transfer is over and did not work. -->
        <span
          v-else-if="item.state === 'failed'"
          class="ml-3 flex h-6 w-6 shrink-0 items-center justify-center text-danger"
          role="img"
          :aria-label="t('upload.failedItem')"
        >
          <AlertCircle :size="18" />
        </span>
        <span
          v-else-if="item.state === 'interrupted'"
          class="ml-3 flex h-6 w-6 shrink-0 items-center justify-center text-text-3"
          role="img"
          :aria-label="t('upload.interruptedItem')"
        >
          <RotateCcw :size="16" />
        </span>
        <span v-else class="ml-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" :class="item.state === 'done' ? 'bg-success text-white' : 'text-transparent'">
          <Check :size="14" :stroke-width="3" />
        </span>
      </li>
    </ul>
    <!-- Off-screen rather than hidden: a display:none input cannot be clicked open in every browser. -->
    <input ref="picker" type="file" class="sr-only" @change="onPicked" />
  </section>
</template>
