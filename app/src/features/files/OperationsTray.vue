<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AlertCircle, Clock, Loader2, X } from 'lucide-vue-next';
import { IconButton } from '@/ui';
import { useOperationsStore } from './operationsStore';

const { t } = useI18n();
const operations = useOperationsStore();
</script>

<template>
  <section
    v-if="operations.open"
    :aria-label="t('op.title')"
    class="w-[360px] overflow-hidden rounded-lg border border-border bg-bg shadow-menu"
  >
    <header class="flex h-12 items-center border-b border-border pl-4 pr-1">
      <span class="flex-1 text-15 font-medium leading-none" aria-live="polite">
        <!-- A failure outranks "in progress": the row that did not work is why the tray is still on screen. -->
        <template v-if="operations.failedCount">{{ t('op.failed', { n: operations.failedCount }, operations.failedCount) }}</template>
        <template v-else>{{ t('op.title') }}</template>
      </span>
      <IconButton :label="t('op.close')" :size="36" class="text-text-3" @click="operations.clear()"><X :size="18" /></IconButton>
    </header>
    <ul class="max-h-[240px] overflow-y-auto py-1">
      <li v-for="item in operations.shown" :key="item.id" class="flex min-h-12 items-start px-4 py-2">
        <span class="mr-3 mt-px flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
          <Loader2 v-if="item.state === 'running'" :size="16" class="animate-spin text-text-3" />
          <Clock v-else-if="item.state === 'pending'" :size="16" class="text-text-3" />
          <AlertCircle v-else :size="16" class="text-danger" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate-safe text-15 leading-tight">{{ item.label }}</p>
          <!-- Why it is still here: the server's own words for a failure, a plain sentence for work that outlived
               the wait. Neither is a toast: both are things the user may need to read twice. -->
          <p v-if="item.state === 'failed'" class="mt-1 text-13 leading-tight text-danger">{{ item.error }}</p>
          <p v-else-if="item.state === 'pending'" class="mt-1 text-13 leading-tight text-text-3">{{ t('op.pending') }}</p>
        </div>
        <IconButton
          v-if="item.state !== 'running'"
          :label="t('op.dismiss')"
          :size="28"
          class="ml-2 shrink-0 text-text-3"
          @click="operations.dismiss(item.id)"
        >
          <X :size="14" />
        </IconButton>
      </li>
    </ul>
  </section>
</template>
