<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { AlertTriangle, Filter, Folder, FolderOpen, Info, LayoutGrid, List, MoreVertical, PencilLine, Plus, Upload } from 'lucide-vue-next';
import FilterChip from '@/features/files/FilterChip.vue';
import AppliedFilters from '@/features/files/AppliedFilters.vue';
import { type FilterId } from '@/features/files/filters';
import { useDragStore } from '@/features/files/dragStore';
import type { Node } from '@/data/types';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useFilterQuery } from '@/features/files/useFilterQuery';
import { useListingKeyboard } from '@/features/files/useListingKeyboard';
import { useUploadStore } from '@/features/files/uploadStore';
import { splitRoute } from '@/lib/path';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useNewMenu } from '@/features/files/useNewMenu';
import { useNodeTaps } from '@/features/files/useNodeTaps';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Button, IconButton, Input } from '@/ui';
import FloatingMenu from '@/ui/FloatingMenu.vue';
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
// The name filter is a fixed 210 beside the chips on the desktop; below `xl` it takes its own row (spec §10).
const { isMobile } = useBreakpoint();
/**
 * Touch (spec §10). A tap opens, a double tap on a file puts its details on the whole screen, a long press is the
 * right button a finger does not have. A mouse keeps the click/double-click/right-click it always had — these
 * handlers do nothing unless the pointer that produced the event is a finger.
 */
const taps = useNodeTaps({
  tap: (node) => void openNode(node),
  doubleTap: (node) => showDetails(node),
  longPress: (node, target) => itemMenu.openFor(node, target),
});

function showDetails(node: Node) {
  files.select(node.id);
  view.detailsOpen = true;
  view.detailsFull = true;
}

function closeDetails() {
  view.detailsOpen = false;
  view.detailsFull = false;
}

const { menu: newMenu, items: newItems, fileInput, folderInput, openAt: openNewMenu, select: onNewSelect, onFilesPicked } = useNewMenu();
const { onKeydown, onMainClick, onMainContextMenu, activeDescendant, open: openNode } = useListingKeyboard();
const itemMenu = useItemMenuStore();
const drag = useDragStore();
const uploads = useUploadStore();

const LISTING_TARGET = 'listing';

/** The path box lives in the bar; its button sits with the other view controls, so the chain ends at its own chevron. */
const breadcrumbs = ref<InstanceType<typeof Breadcrumbs>>();

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
  const dropped = event.dataTransfer;
  drag.end();
  if (!dropped?.files.length) return;
  event.preventDefault();
  // The whole DataTransfer, not its `files`: only this knows a dropped FOLDER from a file, and the store leaves
  // folders out rather than sending a zero-length file named after one.
  void uploads.start(dropped);
}

const FILTERS: FilterId[] = ['type', 'people', 'modified', 'size'];

// Before the watcher below, so the folder is asked for with the filter its address carries.
useFilterQuery();

// Drive AND folder follow the URL (`/files/<drive>/<path…>`). It waits on `files.ready` rather than on the drive
// list being non-empty: `openPath` has to tell an unknown drive from one that has not loaded, and a server that
// never answered from a drive list that is genuinely empty.
//
// ⚠ An address KEY is watched, and as a list of sources rather than as one getter returning a tuple. Both halves
// matter. Every navigation builds a fresh `route.params`, so a query-only change — which the filter writes on
// every chip (see `useFilterQuery`) — re-evaluated the getter; and a getter that returns a new array is a new
// value every time it runs, so the callback fired for an address that had not moved. The folder was reopened
// under the person: the same rows fetched again, and the selection cleared, so narrowing from the details panel
// dropped the very file being described. A list of sources is compared source by source, and a string key of the
// address compares by value.
const address = computed(() => splitRoute(route.params.path));
const addressKey = computed(() => `${address.value.drive ?? ''}://${address.value.path}`);
watch(
  [addressKey, () => files.ready],
  async ([, ready]) => {
    if (!ready || route.name !== 'files') return;
    await files.openPath(address.value.drive, address.value.path);
  },
  { immediate: true },
);
</script>

<template>
  <main
    class="relative min-w-0 flex-1 overflow-y-auto pb-6 pl-4 pr-3 pt-3"
    @click="onMainClick"
    @contextmenu="onMainContextMenu"
    @dragover="onPageDragOver"
    @dragleave="onPageDragLeave"
    @drop="onPageDrop"
  >
    <!-- Drop hint for files coming from the OS; a folder card under the pointer takes the drop instead. -->
    <div
      v-if="drag.overId === LISTING_TARGET"
      class="pointer-events-none absolute inset-2 z-10 flex items-start justify-center rounded-xl border-2 border-dashed border-primary pt-20"
    >
      <!-- Solid pill: the label has to stay readable over whatever thumbnails sit under the overlay. -->
      <p class="flex items-center gap-2 rounded-full bg-bg px-4 py-2.5 text-13 font-medium leading-none text-primary shadow-menu">
        <Upload :size="16" />
        {{ t('files.dropHere', { folder: files.folder?.name ?? '' }) }}
      </p>
    </div>
    <div class="flex h-control-md items-center">
      <Breadcrumbs ref="breadcrumbs" />

      <div class="ml-auto flex items-center">
        <IconButton :label="t('files.breadcrumbPathEdit')" variant="outline" class="mx-2 !w-control-lg" @click="breadcrumbs?.edit()">
          <PencilLine :size="16" />
        </IconButton>
        <div
          role="radiogroup"
          class="flex h-control-md overflow-hidden rounded-md border border-border"
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
            class="flex w-10 items-center justify-center"
            :class="view.mode === mode ? 'bg-primary-soft text-primary-strong' : 'text-text-2 hover:bg-hover-row'"
            @click="view.mode = mode"
          >
            <List v-if="mode === 'list'" :size="16" />
            <LayoutGrid v-else :size="16" />
          </button>
        </div>
        <IconButton
          :label="t('files.details')"
          variant="outline"
          :active="view.detailsOpen"
          class="ml-2 !w-control-lg"
          @click="view.togglePanel('details')"
        >
          <Info :size="16" />
        </IconButton>
      </div>
    </div>

    <!-- Multi-selection only (single selection keeps the filters); the same control-md height as the filter row it replaces, so nothing below moves. -->
    <SelectionBar v-if="files.selected.length >= 2" class="mt-2" :class="view.mode === 'list' && 'mr-[9px]'" />
    <!-- The row WRAPS rather than squeezing: the chips set from the details panel are as many as the node has
         tags, and on one fixed line they pushed the name box and the sort control off the page. It keeps the
         control-md height until there is a second line to draw. -->
    <div v-else class="mt-2 flex min-h-control-md flex-wrap items-center gap-2">
      <div role="group" :aria-label="t('filter.title')" class="chips-scroller flex min-w-0 basis-full items-center gap-2 md:flex-1 md:basis-auto md:flex-wrap">
        <FilterChip v-for="id in FILTERS" :key="id" :id="id" />
        <AppliedFilters />
      </div>
      <!-- Narrows the open folder by name — in memory for a small folder, on the server for a large one (see the
           store); it is cleared on every navigation. -->
      <Input
        :model-value="files.filter.name"
        type="search"
        :icon="Folder"
        :height="28"
        :width="isMobile ? undefined : 210"
        class="!rounded min-w-[110px] flex-1 md:w-auto md:flex-none"
        :placeholder="t('filter.name')"
        :label="t('filter.name')"
        @update:model-value="files.setName(String($event))"
      />
      <SortControl v-if="view.mode === 'list'" variant="pill" class="ml-auto mr-2" />
      <template v-else>
        <SortControl class="ml-auto" />
        <IconButton
          :label="t('files.listingActions')"
          :size="28"
          class="text-text-2"
          aria-haspopup="menu"
          @click="itemMenu.openBackgroundFor($event.currentTarget as HTMLElement)"
        >
          <MoreVertical :size="16" />
        </IconButton>
      </template>

      <!-- The phone's ONE way to create anything (spec §10): the drawer carries no New button, so this is it. -->
      <template v-if="isMobile">
        <Button
          :size="'sm'"
          class="ml-1 !h-control-md !w-control-md !rounded-full !px-0"
          :aria-label="t('new.button')"
          aria-haspopup="menu"
          :aria-expanded="!!newMenu"
          @click="openNewMenu($event.currentTarget as HTMLElement)"
        >
          <Plus :size="18" />
        </Button>
        <FloatingMenu
          v-if="newMenu"
          :items="newItems"
          :x="newMenu.x"
          :y="newMenu.y"
          :label="t('new.button')"
          @select="onNewSelect"
          @close="newMenu = null"
        />
        <input ref="fileInput" type="file" multiple class="hidden" tabindex="-1" :aria-label="t('new.fileUpload')" @change="onFilesPicked" />
        <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" tabindex="-1" :aria-label="t('new.folderUpload')" @change="onFilesPicked" />
      </template>
    </div>

    <ListingSkeleton v-if="files.loading && !files.ordered.length" class="mr-[9px] mt-3" :mode="view.mode" />

    <div v-else-if="view.mode === 'list' && files.ordered.length" class="mr-[9px] mt-3">
      <FileTable
        tabindex="0"
        :aria-activedescendant="activeDescendant"
        @keydown="onKeydown"
        @open="openNode"
        @details="showDetails"
      />
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
        <h2 class="mt-5 text-13 font-semibold leading-none">{{ t('files.folders') }}</h2>
        <div role="group" :aria-label="t('files.folders')" class="mt-2 grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(176px, 1fr))">
          <FolderCard
            v-for="node in files.folders"
            :key="node.id"
            :node="node"
            :selected="files.isSelected(node.id)"
            :focused="files.cursorId === node.id"
            @click="files.selectFromEvent(node.id, $event)"
            @dblclick="openNode(node)"
            @pointerdown="taps.down($event, node)"
            @pointermove="taps.move($event)"
            @pointerup="taps.up($event, node)"
            @pointercancel="taps.cancel()"
            @focus="files.focusedId = node.id"
          />
        </div>
      </template>

      <template v-if="files.files.length">
        <h2 class="mt-5 text-13 font-semibold leading-none">{{ t('files.files') }}</h2>
        <div role="group" :aria-label="t('files.files')" class="mt-2 grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(176px, 1fr))">
          <FileCard
            v-for="node in files.files"
            :key="node.id"
            :node="node"
            :selected="files.isSelected(node.id)"
            :focused="files.cursorId === node.id"
            @click="files.selectFromEvent(node.id, $event)"
            @dblclick="openNode(node)"
            @pointerdown="taps.down($event, node)"
            @pointermove="taps.move($event)"
            @pointerup="taps.up($event, node)"
            @pointercancel="taps.cancel()"
            @focus="files.focusedId = node.id"
          />
        </div>
      </template>
    </div>

    <!-- A load that failed keeps the page usable: say what happened and offer to run it again. -->
    <EmptyState v-else-if="files.error" class="mt-16" :icon="AlertTriangle" :title="t(`error.${files.error}.title`)" :hint="t(`error.${files.error}.hint`)">
      <!-- Not for a refusal: the same request would be refused again, and a button that cannot work reads as a
           bug in the app rather than as an answer about permissions. -->
      <Button v-if="files.error !== 'forbidden'" variant="outline" @click="files.retry()">{{ t('error.retry') }}</Button>
    </EmptyState>

    <!-- A folder can be empty, or emptied by the chips; the second case offers the way out. -->
    <EmptyState
      v-else-if="!files.ordered.length"
      class="mt-16"
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
    @close="closeDetails"
  />
</template>
