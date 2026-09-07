<script setup lang="ts">
import { onMounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Filter, Info } from 'lucide-vue-next';
import type { Node } from '@/data/types';
import DetailsPanel from '@/pages/files/DetailsPanel.vue';
import EmptyState from '@/pages/files/EmptyState.vue';
import ListingSkeleton from '@/pages/files/ListingSkeleton.vue';
import FileTable, { type TableColumn } from '@/pages/files/FileTable.vue';
import SelectionBar from '@/pages/files/SelectionBar.vue';
import SortControl from '@/pages/files/SortControl.vue';
import { useFilesStore, type ListingKind } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Button, IconButton } from '@/ui';
import FilterChip from './FilterChip.vue';
import { type FilterId } from './filters';
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
const view = useViewStore();
const { onKeydown, onMainClick, onMainContextMenu, activeDescendant, open } = useListingKeyboard();

onMounted(() => files.openListing(props.listing));
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]" @click="onMainClick" @contextmenu="onMainContextMenu">
    <div class="flex h-[38px] items-center">
      <h1 class="text-22 font-semibold leading-none">{{ title }}</h1>
    </div>

    <slot name="banner" />

    <SelectionBar v-if="files.selected.length >= 2" class="-mb-[5px] mr-[9px] mt-[7px]" />
    <div v-else class="mt-3 flex h-[38px] items-center gap-[10px]">
      <div role="group" :aria-label="t('filter.title')" class="flex items-center gap-[10px]">
        <FilterChip v-for="id in filters" :key="id" :id="id" />
      </div>
      <SortControl v-if="sortable" variant="pill" class="ml-auto mr-[10px]" />
      <!-- Same toggle as My files, in the same place: a row selected here describes a node like any other. -->
      <IconButton
        :label="t('files.details')"
        variant="outline"
        :active="view.detailsOpen"
        class="!w-11"
        :class="sortable ? '' : 'ml-auto'"
        @click="view.togglePanel('details')"
      >
        <Info :size="20" />
      </IconButton>
    </div>

    <ListingSkeleton v-if="files.loading && !files.ordered.length" class="mr-[9px] mt-[22px]" />

    <div v-else-if="files.ordered.length" class="mr-[9px] mt-[22px]">
      <FileTable
        tabindex="0"
        :aria-activedescendant="activeDescendant"
        :columns="columns"
        :group-by="groupBy"
        @keydown="onKeydown"
        @open="open"
      />
    </div>
    <EmptyState v-else-if="files.error" class="mt-24" :icon="AlertTriangle" :title="t(`error.${files.error}.title`)" :hint="t(`error.${files.error}.hint`)">
      <Button variant="outline" @click="files.retry()">{{ t('error.retry') }}</Button>
    </EmptyState>

    <EmptyState
      v-else-if="files.listing?.kind === listing"
      class="mt-24"
      :icon="files.filtered ? Filter : emptyIcon"
      :title="files.filtered ? t('empty.filtered.title') : emptyTitle"
      :hint="files.filtered ? t('empty.filtered.hint') : emptyHint"
    >
      <Button v-if="files.filtered" variant="outline" @click="files.clearFilter()">{{ t('filter.clear') }}</Button>
    </EmptyState>
  </main>

  <!-- These listings have no folder of their own, so the panel appears only once a row is picked. -->
  <DetailsPanel
    v-if="view.detailsOpen && files.selected.length === 1 && files.focusNode"
    :node="files.focusNode"
    :path="files.focusPath"
    :people="files.people"
    :user="files.user"
    @close="view.detailsOpen = false"
  />
</template>
