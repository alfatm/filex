<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { MoreVertical } from 'lucide-vue-next';
import type { Node } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { IconButton } from '@/ui';
import FileTypeTile from './FileTypeTile.vue';
import Thumbnail from './Thumbnail.vue';

const props = withDefaults(defineProps<{ node: Node; selected: boolean; focused?: boolean }>(), { focused: false });
const { t } = useI18n();
const { formatDate, formatSize } = useFormat();
const itemMenu = useItemMenuStore();

function onContextMenu(event: MouseEvent) {
  itemMenu.openAt(props.node, event.clientX, event.clientY);
}
</script>

<template>
  <!-- Keyboard: focusing a card moves the page cursor to it, so Enter/Space/arrows go through the page handler. -->
  <div
    class="h-[174px] w-[236px] cursor-default select-none rounded-lg border bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:ring-offset-2"
    :class="[
      selected ? 'border-2 border-primary-ring bg-primary-tint' : 'border-border hover:border-border-hover hover:bg-hover-card',
      focused && 'ring-2 ring-primary-ring ring-offset-2',
    ]"
    :id="`node-${node.id}`"
    :aria-selected="selected"
    :data-id="node.id"
    role="option"
    tabindex="0"
    @contextmenu.prevent="onContextMenu"
  >
    <div class="h-[108px] overflow-hidden rounded-t-[11px]" :class="selected && '-mx-px -mt-px'">
      <Thumbnail v-if="node.thumbnail" :kind="node.thumbnail" :duration="node.duration" :src="node.assetUrl" />
    </div>
    <div class="flex h-[66px] items-center pl-[14px] pr-1" :class="selected && '-mx-px'">
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
  </div>
</template>
