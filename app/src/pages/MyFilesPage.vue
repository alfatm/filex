<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { ChevronRight, FolderOpen, Home, Info, LayoutGrid, List, MoreVertical } from 'lucide-vue-next';
import { FILTER_WIDTHS, type FilterId } from '@/features/files/filters';
import { useListingKeyboard } from '@/features/files/useListingKeyboard';
import { filesRoute, joinPath, segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Chip, IconButton } from '@/ui';
import DetailsPanel from './files/DetailsPanel.vue';
import EmptyState from './files/EmptyState.vue';
import FileCard from './files/FileCard.vue';
import FileTable from './files/FileTable.vue';
import FolderCard from './files/FolderCard.vue';
import SelectionBar from './files/SelectionBar.vue';
import SortControl from './files/SortControl.vue';

const { t } = useI18n();
const route = useRoute();
const files = useFilesStore();
const view = useViewStore();
const { onKeydown, onMainClick, activeDescendant, open: openNode } = useListingKeyboard();

const FILTERS: FilterId[] = ['type', 'people', 'modified', 'size'];
const filters = computed(() => FILTERS.map((id) => ({ id, label: t(`filter.${id}`), width: FILTER_WIDTHS[id] })));

// The folder follows the URL (`/files/:path*`); the storage is bootstrapped by App.vue, so wait for it too.
watch(
  () => [joinPath(segments(route.params.path)), files.storage] as const,
  async ([path, storage]) => {
    if (storage && route.name === 'files') await files.openPath(path);
  },
  { immediate: true },
);
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]" @click="onMainClick">
    <div class="flex h-[38px] items-center">
      <IconButton :label="t('files.breadcrumbHome')" class="text-text-2" @click="$router.push(filesRoute([]))"><Home :size="20" /></IconButton>
      <ChevronRight :size="16" class="text-text-3" />
      <h1 class="mx-2 text-18 font-semibold leading-none">{{ files.folder?.name }}</h1>
      <IconButton :label="t('files.siblings')" :size="24" class="text-text-3" :disabled-hint="t('common.comingSoon')"><ChevronRight :size="16" /></IconButton>

      <div class="ml-auto flex items-center">
        <div
          role="radiogroup"
          class="flex h-10 overflow-hidden rounded-md border border-border"
          @keydown.left.prevent="view.mode = view.mode === 'list' ? 'grid' : 'list'"
          @keydown.right.prevent="view.mode = view.mode === 'list' ? 'grid' : 'list'"
        >
          <button
            v-for="mode in ['list', 'grid'] as const"
            :key="mode"
            type="button"
            role="radio"
            :aria-checked="view.mode === mode"
            :aria-label="t(mode === 'list' ? 'files.listView' : 'files.gridView')"
            class="flex w-12 items-center justify-center"
            :class="view.mode === mode ? 'bg-primary-soft text-primary' : 'text-text-2 hover:bg-hover-row'"
            @click="view.mode = mode"
          >
            <List v-if="mode === 'list'" :size="20" />
            <LayoutGrid v-else :size="20" />
          </button>
        </div>
        <IconButton
          :label="t('files.details')"
          variant="outline"
          :active="view.detailsOpen"
          class="ml-[14px] !w-11"
          @click="view.togglePanel('details')"
        >
          <Info :size="20" />
        </IconButton>
      </div>
    </div>

    <!-- Multi-selection only (single selection keeps the filters); centred on the 38px filter row it replaces, so nothing below moves. -->
    <SelectionBar v-if="files.selected.length >= 2" class="-mb-[5px] mt-[7px]" :class="view.mode === 'list' && 'mr-[9px]'" />
    <div v-else class="mt-3 flex h-[38px] items-center gap-[10px]">
      <Chip v-for="chip in filters" :key="chip.id" :label="chip.label" :width="chip.width" :disabled-hint="t('common.comingSoon')" />
      <SortControl v-if="view.mode === 'list'" variant="pill" class="ml-auto mr-[10px]" />
      <template v-else>
        <SortControl class="ml-auto" />
        <IconButton :label="t('files.more')" :size="32" class="text-text-2" :disabled-hint="t('common.comingSoon')"><MoreVertical :size="20" /></IconButton>
      </template>
    </div>

    <div v-if="view.mode === 'list' && files.ordered.length" class="mr-[9px] mt-[22px]">
      <FileTable tabindex="0" :aria-activedescendant="activeDescendant" @keydown="onKeydown" @open="openNode" />
    </div>

    <!-- One listbox for both sections so ↑/↓ walk folders then files; cards stay tabbable and sync the cursor on focus. -->
    <div
      v-if="view.mode === 'grid' && files.ordered.length"
      role="listbox"
      aria-multiselectable="true"
      tabindex="0"
      :aria-activedescendant="activeDescendant"
      class="focus:outline-none"
      @keydown="onKeydown"
    >
      <template v-if="files.folders.length">
        <h2 class="mt-[44px] text-17 font-semibold leading-[26px]">{{ t('files.folders') }}</h2>
        <div role="group" :aria-label="t('files.folders')" class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 236px)">
          <FolderCard
            v-for="node in files.folders"
            :key="node.id"
            :node="node"
            :selected="files.isSelected(node.id)"
            :focused="files.cursorId === node.id"
            @click="files.selectFromEvent(node.id, $event)"
            @dblclick="openNode(node)"
            @focus="files.focusedId = node.id"
          />
        </div>
      </template>

      <template v-if="files.files.length">
        <h2 class="mt-[50px] text-17 font-semibold leading-[26px]">{{ t('files.files') }}</h2>
        <div role="group" :aria-label="t('files.files')" class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 236px)">
          <FileCard
            v-for="node in files.files"
            :key="node.id"
            :node="node"
            :selected="files.isSelected(node.id)"
            :focused="files.cursorId === node.id"
            @click="files.selectFromEvent(node.id, $event)"
            @dblclick="openNode(node)"
            @focus="files.focusedId = node.id"
          />
        </div>
      </template>
    </div>

    <EmptyState v-if="!files.ordered.length" class="mt-24" :icon="FolderOpen" :title="t('files.emptyState')" :hint="t('files.emptyHint')" />
  </main>

  <DetailsPanel
    v-if="view.detailsOpen && files.focusNode"
    :node="files.focusNode"
    :path="files.selected.length === 1 ? [...files.path, files.folder!] : files.path"
    :people="files.people"
    :user="files.user"
    @close="view.detailsOpen = false"
  />
</template>
