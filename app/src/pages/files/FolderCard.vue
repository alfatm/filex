<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { MoreVertical, Star } from 'lucide-vue-next';
import type { Node } from '@/data/types';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useClipboardStore } from '@/features/files/clipboardStore';
import { useNodeDrag } from '@/features/files/useNodeDrag';
import { IconButton } from '@/ui';
import FolderIcon from './FolderIcon.vue';

const props = withDefaults(defineProps<{ node: Node; selected: boolean; focused?: boolean }>(), { focused: false });
const { t } = useI18n();
const itemMenu = useItemMenuStore();
const clipboard = useClipboardStore();
const { drag, onDragStart, onDragOver, onDragLeave, onDrop } = useNodeDrag();

function onContextMenu(event: MouseEvent) {
  itemMenu.openAt(props.node, event.clientX, event.clientY);
}
</script>

<template>
  <!-- Keyboard: focusing a card moves the page cursor to it, so Enter/Space/arrows go through the page handler. -->
  <div
    class="relative flex h-[84px] w-[236px] cursor-pointer select-none items-center rounded-lg border bg-bg pl-5 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:ring-offset-2"
    :class="[
      selected
        ? 'border-primary-ring outline outline-1 outline-primary-ring bg-primary-tint'
        : 'border-border hover:border-border-hover hover:bg-hover-card',
      focused && 'ring-2 ring-primary-ring ring-offset-2',
      drag.overId === node.id && '!border-primary bg-primary-tint ring-2 ring-primary',
      clipboard.isCut(node.id) && 'opacity-50',
    ]"
    :id="`node-${node.id}`"
    :aria-selected="selected"
    :data-id="node.id"
    role="option"
    tabindex="0"
    draggable="true"
    @contextmenu.prevent="onContextMenu"
    @dragstart="onDragStart(node, $event)"
    @dragend="drag.end()"
    @dragover="onDragOver(node, $event)"
    @dragleave="onDragLeave(node)"
    @drop="onDrop(node, $event)"
  >
    <FolderIcon :shared="node.shared" />
    <div class="ml-6 min-w-0 flex-1">
      <p class="truncate-safe text-16 font-medium leading-none">{{ node.name }}</p>
      <p class="mt-1 text-14 leading-none text-text-3">{{ node.itemCount === undefined ? t('type.folder') : t('files.items', node.itemCount) }}</p>
    </div>
    <IconButton :label="t('files.more')" :size="32" class="text-text-3" data-menu-button @click.stop="itemMenu.openFor(node, $event.currentTarget as HTMLElement)" @dblclick.stop>
      <MoreVertical :size="20" />
    </IconButton>
    <!-- Last in DOM so the card's accessible name still starts with the folder name. -->
    <Star v-if="node.starred" :size="14" fill="currentColor" class="absolute right-2.5 top-2 text-folder" role="img" :aria-label="t('panel.starred')" />
  </div>
</template>
