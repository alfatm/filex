<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderMinus, MoreVertical } from 'lucide-vue-next';
import type { SearchHit } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useFilesStore } from '@/stores/files';
import { IconButton } from '@/ui';
import HitIcon from './HitIcon.vue';
import { hitFolderLabel } from './searchStore';
import Snippet from './Snippet.vue';

const props = defineProps<{ hit: SearchHit }>();
const emit = defineEmits<{ open: [hit: SearchHit]; skip: [folderPath: string] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const itemMenu = useItemMenuStore();
const folderLabel = computed(() => hitFolderLabel(props.hit, files.storages));
// A hit sitting at a drive's root has no folder to leave out, so the control is not offered on it — an action
// that would do nothing is worse than an action that is not there.
const skippable = computed(() => props.hit.folderPath !== '');
</script>

<template>
  <tr
    tabindex="0"
    class="group/row h-[42px] cursor-pointer select-none border-b border-border-soft text-13 leading-none hover:bg-hover-row focus-visible:bg-hover-row focus-visible:outline-none [&>td]:p-0"
    @click="emit('open', hit)"
    @keydown.enter.self="emit('open', hit)"
  >
    <td class="!pl-3">
      <div class="flex items-center">
        <HitIcon :node="hit.node" />
        <span class="ml-5 truncate text-13 font-medium text-text">{{ hit.node.name }}</span>
        <span v-if="hit.node.kind === 'folder'" class="ml-4 shrink-0 text-text-3">{{ hit.node.itemCount === undefined ? t('type.folder') : t('files.items', hit.node.itemCount) }}</span>
      </div>
    </td>
    <td class="truncate text-text-3">{{ folderLabel }}</td>
    <td class="truncate text-text-3">
      <Snippet v-if="hit.snippet" :text="hit.snippet.text" :ranges="hit.snippet.ranges" />
    </td>
    <td class="truncate">{{ formatDateTime(hit.node.modifiedAt) }}</td>
    <td class="truncate">{{ hit.node.kind === 'folder' ? '—' : formatSize(hit.node.size) }}</td>
    <td class="!pr-[7px] text-right">
      <!--
        "Skip this folder" is the commonest thing a person wants from a result they did not want: the folder is
        not what their words said, it is what the drive happens to hold. It sits on the ROW rather than in the
        item menu next to it because that menu is the files menu — it acts on a node through the files store and
        knows nothing about a search — while this acts on the QUERY, and the folder it names is the hit's, which
        only the row has. Revealed on hover or keyboard focus, like any row action; never a permanent third icon
        in a 42px row.
      -->
      <IconButton
        v-if="skippable"
        :label="t('search.skipFolder', { folder: folderLabel })"
        :size="32"
        class="text-text-3 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100"
        @click.stop="emit('skip', hit.folderPath)"
      >
        <FolderMinus :size="18" />
      </IconButton>
      <!-- The same item menu as the file listings; its actions run through the files store and re-run the search. -->
      <IconButton :label="t('files.more')" :size="32" class="text-text-3" data-menu-button @click.stop="itemMenu.openFor(hit.node, $event.currentTarget as HTMLElement)">
        <MoreVertical :size="20" />
      </IconButton>
    </td>
  </tr>
</template>
