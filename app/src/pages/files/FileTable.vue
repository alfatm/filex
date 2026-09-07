<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDown, ArrowUp, MoreVertical, Star } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import type { Node } from '@/data/types';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useClipboardStore } from '@/features/files/clipboardStore';
import { useNodeDrag } from '@/features/files/useNodeDrag';
import { useSettingsStore } from '@/features/settings/settingsStore';
import HitIcon from '@/features/search/HitIcon.vue';
import { useFilesStore } from '@/stores/files';
import { useViewStore, type SortKey } from '@/stores/view';
import { Avatar, Checkbox, IconButton } from '@/ui';

/** Columns right of Name; the flat listings (Shared, Trash) swap in their own. */
export type TableColumn = 'owner' | 'lastModified' | 'fileSize' | 'sharedBy' | 'sharedOn' | 'deleted' | 'originalPath';

const props = withDefaults(
  defineProps<{
    columns?: TableColumn[];
    /** Inserts a heading row whenever the key changes (Recent's "Today" / "Yesterday"). */
    groupBy?: (node: Node) => string;
  }>(),
  { columns: () => ['owner', 'lastModified', 'fileSize'], groupBy: undefined },
);
const emit = defineEmits<{ open: [node: Node] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const view = useViewStore();
const itemMenu = useItemMenuStore();
const clipboard = useClipboardStore();
const { drag, onDragStart, onDragOver, onDragLeave, onDrop } = useNodeDrag();
const settings = useSettingsStore();

// Spec §4: name flex, owner 160, modified 236, size 160; 12px outer padding. The menu column is the spec's 48 plus
// the 12px the table extends past the ⋮ (icon at x 1618, table edge 1651): a narrower column would widen the flex
// name column and push Owner off x 1035.
const COLUMN_DEFS = {
  owner: { width: 160 },
  lastModified: { sort: 'modified', width: 236 },
  fileSize: { sort: 'size', width: 160 },
  sharedBy: { width: 220 },
  sharedOn: { width: 236 },
  deleted: { width: 236 },
  originalPath: { width: 260 },
} satisfies Record<TableColumn, { sort?: SortKey; width: number }>;

const columns = computed(() => props.columns.map((id) => ({ id, ...(COLUMN_DEFS[id] as { sort?: SortKey; width: number }) })));

const rows = computed(() =>
  files.ordered.map((node, i, all) => {
    const key = props.groupBy?.(node);
    const heading = key !== undefined && (i === 0 || props.groupBy?.(all[i - 1]) !== key) ? key : null;
    return { node, heading };
  }),
);

function onHeaderCheckbox() {
  if (files.allState === 'all') files.clearSelection();
  else files.selectAll();
}

function owner(node: Node): string {
  return node.ownerId === files.user?.id ? t('panel.you') : (node.ownerName ?? node.ownerId);
}

function openMenu(node: Node, event: MouseEvent) {
  itemMenu.openFor(node, event.currentTarget as HTMLElement);
}

/** Right-click acts on the row under the cursor: it joins the selection unless already part of it. */
function onContextMenu(node: Node, event: MouseEvent) {
  if (!files.isSelected(node.id)) files.select(node.id);
  itemMenu.openAt(node, event.clientX, event.clientY);
}
</script>

<template>
  <!-- The page owns the keyboard scope (tabindex, aria-activedescendant, keydown) and passes it through $attrs. -->
  <table class="w-full table-fixed border-collapse focus:outline-none" role="grid" aria-multiselectable="true">
    <colgroup>
      <col style="width: 63px" />
      <col />
      <col v-for="col in columns" :key="col.id" :style="{ width: `${col.width}px` }" />
      <col style="width: 60px" />
    </colgroup>
    <thead>
      <tr class="h-[38px] border-b border-border text-15 leading-none text-text-2 [&>th]:p-0">
        <th class="!pl-3 text-left font-normal">
          <Checkbox
            :label="t('files.selectAll')"
            :model-value="files.allState === 'all'"
            @update:model-value="onHeaderCheckbox"
          />
        </th>
        <th class="text-left font-normal" :aria-sort="view.sortKey === 'name' ? (view.sortDir === 'asc' ? 'ascending' : 'descending') : undefined">
          <button type="button" class="inline-flex h-[38px] items-center gap-1 hover:text-text" @click="view.setSortKey('name')">
            <span>{{ t('files.name') }}</span>
            <template v-if="view.sortKey === 'name'">
              <ArrowUp v-if="view.sortDir === 'asc'" :size="16" />
              <ArrowDown v-else :size="16" />
            </template>
          </button>
        </th>
        <th
          v-for="col in columns"
          :key="col.id"
          class="text-left font-normal"
          :aria-sort="col.sort && view.sortKey === col.sort ? (view.sortDir === 'asc' ? 'ascending' : 'descending') : undefined"
        >
          <button v-if="col.sort" type="button" class="inline-flex h-[38px] items-center gap-1 hover:text-text" @click="view.setSortKey(col.sort)">
            <span>{{ t(`files.${col.id}`) }}</span>
            <template v-if="view.sortKey === col.sort">
              <ArrowUp v-if="view.sortDir === 'asc'" :size="16" />
              <ArrowDown v-else :size="16" />
            </template>
          </button>
          <span v-else>{{ t(`files.${col.id}`) }}</span>
        </th>
        <th><span class="sr-only">{{ t('files.more') }}</span></th>
      </tr>
    </thead>
    <tbody>
      <template v-for="{ node, heading } in rows" :key="node.id">
        <tr v-if="heading" class="[&>td]:p-0">
          <td :colspan="columns.length + 3" class="h-[46px] pt-3 align-bottom text-15 font-semibold leading-none text-text-2">{{ heading }}</td>
        </tr>
        <tr
          :id="`node-${node.id}`"
          :data-id="node.id"
          role="row"
          :aria-selected="files.isSelected(node.id)"
          class="cursor-pointer select-none border-b border-border-soft text-15 leading-none [&>td]:p-0"
          :class="[
            settings.settings.compactList ? 'h-[34px]' : 'h-[42px]',
            files.isSelected(node.id) ? 'bg-primary-soft' : 'hover:bg-hover-row',
            files.cursorId === node.id && 'cursor-row',
            drag.overId === node.id && '!bg-primary-tint outline outline-2 -outline-offset-2 outline-primary',
            clipboard.isCut(node.id) && 'opacity-50',
          ]"
          draggable="true"
          @click="files.selectFromEvent(node.id, $event)"
          @dblclick="emit('open', node)"
          @contextmenu.prevent="onContextMenu(node, $event)"
          @dragstart="onDragStart(node, $event)"
          @dragend="drag.end()"
          @dragover="onDragOver(node, $event)"
          @dragleave="onDragLeave(node)"
          @drop="onDrop(node, $event)"
        >
          <td class="!pl-3">
            <Checkbox
              :label="t('files.selectItem', { name: node.name })"
              :model-value="files.isSelected(node.id)"
              @update:model-value="files.toggle(node.id)"
              @click.stop
            />
          </td>
          <td>
            <div class="flex items-center">
              <HitIcon :node="node" />
              <span class="ml-5 min-w-[96px] truncate pr-2 text-16 font-medium text-text">{{ node.name }}</span>
              <Star v-if="node.starred" :size="14" fill="currentColor" class="mr-2 shrink-0 text-folder" role="img" :aria-label="t('panel.starred')" />
              <span v-if="node.kind === 'folder'" class="shrink-0 text-text-3">
                {{ node.itemCount === undefined ? t('type.folder') : t('files.items', node.itemCount) }}
              </span>
            </div>
          </td>
          <td v-for="col in columns" :key="col.id" class="truncate">
            <template v-if="col.id === 'owner'">{{ owner(node) }}</template>
            <template v-else-if="col.id === 'lastModified'">{{ formatDateTime(node.modifiedAt) }}</template>
            <template v-else-if="col.id === 'fileSize'">{{ node.kind === 'folder' ? '—' : formatSize(node.size) }}</template>
            <span v-else-if="col.id === 'sharedBy'" class="flex items-center">
              <Avatar :initial="(node.sharedBy ?? '?').charAt(0)" :size="28" class="!text-13" />
              <span class="ml-2.5 truncate">{{ node.sharedBy }}</span>
            </span>
            <template v-else-if="col.id === 'sharedOn'">{{ node.sharedAt ? formatDateTime(node.sharedAt) : '—' }}</template>
            <template v-else-if="col.id === 'deleted'">{{ node.deletedAt ? formatDateTime(node.deletedAt) : '—' }}</template>
            <template v-else-if="col.id === 'originalPath'">{{ node.originalPath ?? '—' }}</template>
          </td>
          <td class="!pr-[7px] text-right">
            <IconButton :label="t('files.more')" :size="32" class="text-text-3" data-menu-button @click.stop="openMenu(node, $event)" @dblclick.stop>
              <MoreVertical :size="20" />
            </IconButton>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
</template>

<style scoped>
/* Keyboard cursor ring. Chrome does not paint outline/box-shadow on <tr>, so the ring is composed on the cells. */
.cursor-row > td {
  box-shadow:
    inset 0 2px 0 0 var(--c-primary-ring),
    inset 0 -2px 0 0 var(--c-primary-ring);
}
.cursor-row > td:first-child {
  box-shadow:
    inset 2px 0 0 0 var(--c-primary-ring),
    inset 0 2px 0 0 var(--c-primary-ring),
    inset 0 -2px 0 0 var(--c-primary-ring);
}
.cursor-row > td:last-child {
  box-shadow:
    inset -2px 0 0 0 var(--c-primary-ring),
    inset 0 2px 0 0 var(--c-primary-ring),
    inset 0 -2px 0 0 var(--c-primary-ring);
}
</style>
