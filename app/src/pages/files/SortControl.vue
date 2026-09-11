<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-vue-next';
import { SORT_KEYS, useViewStore } from '@/stores/view';
import { IconButton } from '@/ui';
import FloatingMenu, { anchorBelow } from '@/ui/FloatingMenu.vue';

/**
 * Sort state mirror. `plain` is the grid's text button (spec §3); `pill` is
 * the bordered control right of the filter chips in list view (spec §4).
 * Both carry the key menu: in grid view the table headers are not there to
 * sort by, so without it the grid could only flip the direction of one key.
 */
withDefaults(defineProps<{ variant?: 'plain' | 'pill' }>(), { variant: 'plain' });

const { t } = useI18n();
const view = useViewStore();

const MENU_WIDTH = 160;
const menu = ref<{ x: number; y: number } | null>(null);
const items = computed(() => SORT_KEYS.map((id) => ({ id, label: t(`sort.${id}`) })));

function pick(id: string) {
  menu.value = null;
  const key = SORT_KEYS.find((k) => k === id);
  if (key) view.setSortKey(key);
}
</script>

<template>
  <div
    class="flex items-center"
    :class="variant === 'pill' && 'h-control-md overflow-visible rounded-md border border-border bg-bg'"
  >
    <button
      type="button"
      class="flex items-center gap-1 text-13 leading-none text-text hover:bg-hover-row"
      :class="variant === 'pill' ? 'h-full rounded-l-md pl-3 pr-2' : 'h-control-sm rounded px-2'"
      @click="view.toggleSortDir()"
    >
      <span>{{ t(`sort.${view.sortKey}`) }}</span>
      <!-- Accessible name reads "Name, ascending"; the arrow alone says nothing to a screen reader. -->
      <span class="sr-only">, {{ t(view.sortDir === 'asc' ? 'sort.ascending' : 'sort.descending') }}</span>
      <ArrowUp v-if="view.sortDir === 'asc'" :size="14" />
      <ArrowDown v-else :size="14" />
    </button>
    <span v-if="variant === 'pill'" class="h-full w-px bg-border" />
    <IconButton
      :label="t('sort.by')"
      :size="28"
      class="text-text-2"
      :class="variant === 'pill' && 'rounded-l-none rounded-r-md'"
      aria-haspopup="menu"
      :aria-expanded="!!menu"
      @click="menu = anchorBelow($event.currentTarget as HTMLElement, MENU_WIDTH)"
    >
      <ChevronDown :size="14" />
    </IconButton>
    <FloatingMenu v-if="menu" :items="items" :x="menu.x" :y="menu.y" :width="MENU_WIDTH" :label="t('sort.by')" @select="pick" @close="menu = null" />
  </div>
</template>
