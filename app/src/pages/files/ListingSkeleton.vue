<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** Placeholder while a listing loads: the shapes of the grid cards or the table rows, at their real sizes. */
withDefaults(defineProps<{ mode?: 'grid' | 'list'; rows?: number }>(), { mode: 'list', rows: 8 });

const { t } = useI18n();
const bar = 'rounded bg-bg-muted';
</script>

<template>
  <div class="animate-pulse" role="status" :aria-label="t('common.loading')">
    <div v-if="mode === 'grid'" class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(176px, 1fr))">
      <div v-for="i in rows" :key="i" class="h-[166px] w-full rounded-lg border border-border">
        <div class="h-[108px] rounded-t-[9px] bg-bg-muted" />
        <div class="flex h-[58px] items-center px-2">
          <div :class="[bar, 'h-6 w-6 shrink-0']" />
          <div class="ml-2 min-w-0 flex-1">
            <div :class="[bar, 'h-3 w-3/4']" />
            <div :class="[bar, 'mt-2 h-2.5 w-1/2']" />
          </div>
        </div>
      </div>
    </div>
    <div v-else>
      <div v-for="i in rows" :key="i" class="flex h-[34px] items-center border-b border-border-soft pl-3">
        <div :class="[bar, 'h-5 w-5 shrink-0']" />
        <div :class="[bar, 'ml-4 h-5 w-5 shrink-0']" />
        <div :class="[bar, 'ml-4 h-3 w-[220px]']" />
        <div :class="[bar, 'ml-auto mr-[9px] h-3 w-[120px]']" />
      </div>
    </div>
  </div>
</template>
