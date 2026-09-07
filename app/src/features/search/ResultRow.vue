<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MoreVertical } from 'lucide-vue-next';
import type { SearchHit } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useFilesStore } from '@/stores/files';
import { IconButton } from '@/ui';
import HitIcon from './HitIcon.vue';
import { hitFolderLabel } from './searchStore';
import Snippet from './Snippet.vue';

const props = defineProps<{ hit: SearchHit }>();
const emit = defineEmits<{ open: [hit: SearchHit] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const itemMenu = useItemMenuStore();
const folderLabel = computed(() => hitFolderLabel(props.hit, files.storages));
</script>

<template>
  <tr
    tabindex="0"
    class="h-[42px] cursor-default select-none border-b border-border-soft text-15 leading-none hover:bg-hover-row focus-visible:bg-hover-row focus-visible:outline-none [&>td]:p-0"
    @click="emit('open', hit)"
    @keydown.enter.self="emit('open', hit)"
  >
    <td class="!pl-3">
      <div class="flex items-center">
        <HitIcon :node="hit.node" />
        <span class="ml-5 truncate text-16 font-medium text-text">{{ hit.node.name }}</span>
        <span v-if="hit.node.kind === 'folder'" class="ml-4 shrink-0 text-text-3">{{ t('files.items', hit.node.itemCount ?? 0) }}</span>
      </div>
    </td>
    <td class="truncate text-text-3">{{ folderLabel }}</td>
    <td class="truncate text-text-3">
      <Snippet v-if="hit.snippet" :text="hit.snippet.text" :ranges="hit.snippet.ranges" />
    </td>
    <td class="truncate">{{ formatDateTime(hit.node.modifiedAt) }}</td>
    <td class="truncate">{{ hit.node.kind === 'folder' ? '—' : formatSize(hit.node.size) }}</td>
    <td class="!pr-[7px] text-right">
      <!-- The same item menu as the file listings; its actions run through the files store and re-run the search. -->
      <IconButton :label="t('files.more')" :size="32" class="text-text-3" data-menu-button @click.stop="itemMenu.openFor(hit.node, $event.currentTarget as HTMLElement)">
        <MoreVertical :size="20" />
      </IconButton>
    </td>
  </tr>
</template>
