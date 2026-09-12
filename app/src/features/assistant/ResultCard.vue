<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ExternalLink, FolderOpen, MoreVertical } from 'lucide-vue-next';
import type { SearchHit } from '@/data/types';
import { useFileActions } from '@/features/files/useFileActions';
import HitIcon from '@/features/search/HitIcon.vue';
import { hitFolderLabel } from '@/features/search/searchStore';
import Snippet from '@/features/search/Snippet.vue';
import { filesRoute, segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { IconButton } from '@/ui';
import FloatingMenu, { anchorBelow, type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

const props = defineProps<{ hit: SearchHit }>();

const { t } = useI18n();
const router = useRouter();
const files = useFilesStore();
const actions = useFileActions();

const folderLabel = computed(() => hitFolderLabel(props.hit, files.storages));

const MENU_WIDTH = 220;
const menu = ref<{ x: number; y: number } | null>(null);
const items = computed<FloatingMenuEntry[]>(() => [
  { id: 'open', label: t('assistant.menu.open'), icon: ExternalLink },
  { id: 'showInFolder', label: t('assistant.menu.showInFolder'), icon: FolderOpen },
]);

function onSelect(id: string) {
  menu.value = null;
  // `hit.folderPath` is already relative to the storage root, i.e. the `files` route's segments.
  const folder = segments(props.hit.folderPath);
  // Files preview in place (one card, so no ← → neighbours); folders open themselves.
  if (id === 'open' && props.hit.node.kind === 'file') actions.preview(props.hit.node, [props.hit.node]);
  else if (id === 'open') void router.push(filesRoute(props.hit.storageId, [...folder, props.hit.node.name]));
  else if (id === 'showInFolder') void router.push(filesRoute(props.hit.storageId, folder));
}
</script>

<template>
  <article :aria-label="hit.node.name" class="flex items-start rounded-lg border border-border p-[14px]">
    <HitIcon :node="hit.node" :size="40" />
    <div class="ml-3 min-w-0 flex-1">
      <p class="truncate-safe text-13 font-medium leading-none">{{ hit.node.name }}</p>
      <p class="mt-1 truncate-safe text-11.5 leading-none text-text-3">{{ folderLabel }}</p>
      <p v-if="hit.snippet" class="mt-1 text-11.5 leading-tight text-text-3">
        <Snippet :text="hit.snippet.text" :ranges="hit.snippet.ranges" />
      </p>
    </div>
    <IconButton
      :label="t('assistant.more')"
      :size="32"
      class="-mr-1.5 -mt-1.5 text-text-3"
      aria-haspopup="menu"
      :aria-expanded="!!menu"
      @click="menu = anchorBelow($event.currentTarget as HTMLElement, MENU_WIDTH)"
    >
      <MoreVertical :size="20" />
    </IconButton>
    <FloatingMenu v-if="menu" :items="items" :x="menu.x" :y="menu.y" :width="MENU_WIDTH" :label="t('assistant.more')" @select="onSelect" @close="menu = null" />
  </article>
</template>
