<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { MoreVertical, Star } from 'lucide-vue-next';
import type { Node } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useClipboardStore } from '@/features/files/clipboardStore';
import { useNodeDrag } from '@/features/files/useNodeDrag';
import { IconButton } from '@/ui';
import FileTypeTile from './FileTypeTile.vue';
import Thumbnail from './Thumbnail.vue';

const props = withDefaults(defineProps<{ node: Node; selected: boolean; focused?: boolean }>(), { focused: false });
const { t } = useI18n();
const { formatDate, formatSize } = useFormat();
const itemMenu = useItemMenuStore();
const clipboard = useClipboardStore();
const { drag, onDragStart } = useNodeDrag();

function onContextMenu(event: MouseEvent) {
  itemMenu.openAt(props.node, event.clientX, event.clientY);
}
</script>

<template>
  <!-- Keyboard: focusing a card moves the page cursor to it, so Enter/Space/arrows go through the page handler.
       Selected draws its second pixel with an outline, not a thicker border: a 2px border comes out of the content
       box, which shifted the thumbnail and left its top corners on the wrong radius. -->
  <div
    class="relative h-[174px] w-[236px] cursor-pointer select-none rounded-lg border bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:ring-offset-2"
    :class="[
      selected ? 'border-primary-ring outline outline-1 outline-primary-ring bg-primary-tint' : 'border-border hover:border-border-hover hover:bg-hover-card',
      focused && 'ring-2 ring-primary-ring ring-offset-2',
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
  >
    <div class="h-[108px] overflow-hidden rounded-t-[11px]">
      <Thumbnail v-if="node.thumbnail" :kind="node.thumbnail" :duration="node.duration" :src="node.thumbUrl" />
    </div>
    <div class="flex h-[66px] items-center pl-[14px] pr-1">
      <FileTypeTile :type="node.fileType ?? 'other'" />
      <div class="ml-2.5 min-w-0 flex-1">
        <p class="truncate-safe text-15 font-medium leading-none">{{ node.name }}</p>
        <p class="mt-1 truncate-safe text-13 leading-none text-text-3">
          {{ formatSize(node.size) }} • {{ formatDate(node.modifiedAt) }}
        </p>
      </div>
      <IconButton :label="t('files.more')" :size="32" class="text-text-3" data-menu-button @click.stop="itemMenu.openFor(node, $event.currentTarget as HTMLElement)" @dblclick.stop>
        <MoreVertical :size="20" />
      </IconButton>
    </div>
    <!-- Starred badge, last in DOM so the card's accessible name still starts with the file name; the disc keeps it readable on any thumbnail. -->
    <span
      v-if="node.starred"
      class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-bg text-folder shadow-sm"
      role="img"
      :aria-label="t('panel.starred')"
    >
      <Star :size="14" fill="currentColor" />
    </span>
  </div>
</template>
