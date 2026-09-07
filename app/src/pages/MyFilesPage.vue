<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { AlertTriangle, Filter, FolderOpen, Info, LayoutGrid, List, MoreVertical, Upload } from 'lucide-vue-next';
import FilterChip from '@/features/files/FilterChip.vue';
import { type FilterId } from '@/features/files/filters';
import { useDragStore } from '@/features/files/dragStore';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useListingKeyboard } from '@/features/files/useListingKeyboard';
import { useUploadStore } from '@/features/files/uploadStore';
import { joinPath, segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Button, IconButton } from '@/ui';
import Breadcrumbs from './files/Breadcrumbs.vue';
import DetailsPanel from './files/DetailsPanel.vue';
import EmptyState from './files/EmptyState.vue';
import ListingSkeleton from './files/ListingSkeleton.vue';
import FileCard from './files/FileCard.vue';
import FileTable from './files/FileTable.vue';
import FolderCard from './files/FolderCard.vue';
import SelectionBar from './files/SelectionBar.vue';
import SortControl from './files/SortControl.vue';

const { t } = useI18n();
const route = useRoute();
const files = useFilesStore();
const view = useViewStore();
const { onKeydown, onMainClick, onMainContextMenu, activeDescendant, open: openNode } = useListingKeyboard();
const itemMenu = useItemMenuStore();
const drag = useDragStore();
const uploads = useUploadStore();

const LISTING_TARGET = 'listing';

/** Files dragged in from the OS land in the open folder unless a folder card takes the drop first. */
function onPageDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  drag.files = true;
  drag.overId = LISTING_TARGET;
  event.dataTransfer.dropEffect = 'copy';
}

function onPageDragLeave(event: DragEvent) {
  // dragleave also fires when the pointer crosses into a child; only a real exit ends the drag.
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as HTMLElement | null)) return;
  drag.end();
}

function onPageDrop(event: DragEvent) {
  const dropped = event.dataTransfer?.files;
  drag.end();
  if (!dropped?.length) return;
  event.preventDefault();
  void uploads.start(dropped);
}

const FILTERS: FilterId[] = ['type', 'people', 'modified', 'size'];

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
  <main
    class="relative min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]"
    @click="onMainClick"
    @contextmenu="onMainContextMenu"
    @dragover="onPageDragOver"
    @dragleave="onPageDragLeave"
    @drop="onPageDrop"
  >
    <!-- Drop hint for files coming from the OS; a folder card under the pointer takes the drop instead. -->
    <div
      v-if="drag.overId === LISTING_TARGET"
      class="pointer-events-none absolute inset-2 z-10 flex items-start justify-center rounded-xl border-2 border-dashed border-primary pt-24"
    >
      <!-- Solid pill: the label has to stay readable over whatever thumbnails sit under the overlay. -->
      <p class="flex items-center gap-2 rounded-full bg-bg px-5 py-3 text-17 font-medium leading-none text-primary shadow-menu">
        <Upload :size="20" />
        {{ t('files.dropHere', { folder: files.folder?.name ?? '' }) }}
      </p>
    </div>
    <div class="flex h-[38px] items-center">
      <Breadcrumbs />

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
      <div role="group" :aria-label="t('filter.title')" class="flex items-center gap-[10px]">
        <FilterChip v-for="id in FILTERS" :key="id" :id="id" />
      </div>
      <SortControl v-if="view.mode === 'list'" variant="pill" class="ml-auto mr-[10px]" />
      <template v-else>
        <SortControl class="ml-auto" />
        <IconButton
          :label="t('files.listingActions')"
          :size="32"
          class="text-text-2"
          aria-haspopup="menu"
          @click="itemMenu.openBackgroundFor($event.currentTarget as HTMLElement)"
        >
          <MoreVertical :size="20" />
        </IconButton>
      </template>
    </div>

    <ListingSkeleton v-if="files.loading && !files.ordered.length" class="mr-[9px] mt-[22px]" :mode="view.mode" />

    <div v-else-if="view.mode === 'list' && files.ordered.length" class="mr-[9px] mt-[22px]">
      <FileTable tabindex="0" :aria-activedescendant="activeDescendant" @keydown="onKeydown" @open="openNode" />
    </div>

    <!-- One listbox for both sections so ↑/↓ walk folders then files; cards stay tabbable and sync the cursor on focus. -->
    <div
      v-else-if="view.mode === 'grid' && files.ordered.length"
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

    <!-- A load that failed keeps the page usable: say what happened and offer to run it again. -->
    <EmptyState v-else-if="files.error" class="mt-24" :icon="AlertTriangle" :title="t(`error.${files.error}.title`)" :hint="t(`error.${files.error}.hint`)">
      <Button variant="outline" @click="files.retry()">{{ t('error.retry') }}</Button>
    </EmptyState>

    <!-- A folder can be empty, or emptied by the chips; the second case offers the way out. -->
    <EmptyState
      v-else-if="!files.ordered.length"
      class="mt-24"
      :icon="files.filtered ? Filter : FolderOpen"
      :title="files.filtered ? t('empty.filtered.title') : t('files.emptyState')"
      :hint="files.filtered ? t('empty.filtered.hint') : t('files.emptyHint')"
    >
      <Button v-if="files.filtered" variant="outline" @click="files.clearFilter()">{{ t('filter.clear') }}</Button>
    </EmptyState>
  </main>

  <DetailsPanel
    v-if="view.detailsOpen && files.focusNode"
    :node="files.focusNode"
    :path="files.focusPath"
    :people="files.people"
    :user="files.user"
    @close="view.detailsOpen = false"
  />
</template>
