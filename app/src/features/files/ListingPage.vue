<script setup lang="ts">
import { computed, onMounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Node } from '@/data/types';
import EmptyState from '@/pages/files/EmptyState.vue';
import FileTable, { type TableColumn } from '@/pages/files/FileTable.vue';
import SelectionBar from '@/pages/files/SelectionBar.vue';
import SortControl from '@/pages/files/SortControl.vue';
import { useFilesStore, type ListingKind } from '@/stores/files';
import { Chip } from '@/ui';
import { FILTER_WIDTHS, type FilterId } from './filters';
import { useListingKeyboard } from './useListingKeyboard';

/** Shared frame of Shared / Recent / Starred / Trash (spec §7): title 22/600, filter chips, the file table. */
const props = withDefaults(
  defineProps<{
    listing: ListingKind;
    title: string;
    filters?: FilterId[];
    columns?: TableColumn[];
    groupBy?: (node: Node) => string;
    /** Recent's order is fixed, so it hides the sort control. */
    sortable?: boolean;
    emptyIcon: Component;
    emptyTitle: string;
    emptyHint?: string;
  }>(),
  { filters: () => ['type', 'people', 'modified'], columns: undefined, groupBy: undefined, sortable: true, emptyHint: undefined },
);

const { t } = useI18n();
const files = useFilesStore();
const { onKeydown, onMainClick, activeDescendant, open } = useListingKeyboard();

const chips = computed(() => props.filters.map((id) => ({ id, label: t(`filter.${id}`), width: FILTER_WIDTHS[id] })));

onMounted(() => files.openListing(props.listing));
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]" @click="onMainClick">
    <div class="flex h-[38px] items-center">
      <h1 class="text-22 font-semibold leading-none">{{ title }}</h1>
    </div>

    <slot name="banner" />

    <SelectionBar v-if="files.selected.length >= 2" class="-mb-[5px] mr-[9px] mt-[7px]" />
    <div v-else class="mt-3 flex h-[38px] items-center gap-[10px]">
      <Chip v-for="chip in chips" :key="chip.id" :label="chip.label" :width="chip.width" :disabled-hint="t('common.comingSoon')" />
      <SortControl v-if="sortable" variant="pill" class="ml-auto mr-[10px]" />
    </div>

    <div v-if="files.ordered.length" class="mr-[9px] mt-[22px]">
      <FileTable
        tabindex="0"
        :aria-activedescendant="activeDescendant"
        :columns="columns"
        :group-by="groupBy"
        @keydown="onKeydown"
        @open="open"
      />
    </div>
    <EmptyState v-else-if="files.listing?.kind === listing" class="mt-24" :icon="emptyIcon" :title="emptyTitle" :hint="emptyHint" />
  </main>
</template>
