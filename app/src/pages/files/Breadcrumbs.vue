<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ChevronRight, Home, MoreHorizontal } from 'lucide-vue-next';
import { repository } from '@/data';
import { filesRoute } from '@/lib/path';
import { useNodeDrag } from '@/features/files/useNodeDrag';
import { useFilesStore } from '@/stores/files';
import { IconButton } from '@/ui';
import FloatingMenu, { anchorBelow, type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

/**
 * Path of the open folder (spec §3): home button, the chain, the current folder in 18/600, then a chevron that
 * descends into its subfolders. A long chain keeps its first and last two crumbs and folds the rest behind "…".
 */
const KEEP_HEAD = 1;
const KEEP_TAIL = 2;
const MENU_WIDTH = 232;

const { t } = useI18n();
const router = useRouter();
const files = useFilesStore();
const { drag, onDragOver, onDragLeave, onDrop } = useNodeDrag();

const menu = ref<{ x: number; y: number; items: FloatingMenuEntry[]; label: string } | null>(null);

/** Root first, current folder last; every crumb carries the route segments that open it. */
const crumbs = computed(() => {
  const chain = [...files.path, files.folder].filter((n) => n !== null);
  return chain.map((node, index) => ({ node, parts: chain.slice(1, index + 1).map((n) => n.name) }));
});

const head = computed(() => crumbs.value.slice(0, KEEP_HEAD));
const folded = computed(() => (crumbs.value.length > KEEP_HEAD + KEEP_TAIL ? crumbs.value.slice(KEEP_HEAD, -KEEP_TAIL) : []));
const tail = computed(() => (folded.value.length ? crumbs.value.slice(-KEEP_TAIL) : crumbs.value.slice(KEEP_HEAD)));

function go(parts: string[]) {
  menu.value = null;
  if (files.storage) void router.push(filesRoute(files.storage.id, parts));
}

function openFolded(event: MouseEvent) {
  menu.value = {
    ...anchorBelow(event.currentTarget as HTMLElement, MENU_WIDTH),
    label: t('files.breadcrumbMore'),
    items: folded.value.map((crumb) => ({ id: crumb.parts.join('/'), label: crumb.node.name })),
  };
}

/** The chevron after the current folder: its subfolders, read fresh so the filter chips do not hide any. */
async function openSubfolders(event: MouseEvent) {
  const current = files.folder;
  if (!current) return;
  const anchor = anchorBelow(event.currentTarget as HTMLElement, MENU_WIDTH);
  const children = (await repository.listFolder(current.id)).filter((n) => n.kind === 'folder');
  const here = crumbs.value.at(-1)?.parts ?? [];
  menu.value = {
    ...anchor,
    label: t('files.subfolders'),
    items: children.length
      ? children.map((node) => ({ id: [...here, node.name].join('/'), label: node.name }))
      : [{ id: '', label: t('files.noSubfolders'), disabled: true }],
  };
}
</script>

<template>
  <nav class="flex min-w-0 items-center" :aria-label="t('files.breadcrumb')">
    <IconButton :label="t('files.breadcrumbHome')" class="text-text-2" @click="go([])"><Home :size="20" /></IconButton>

    <template v-for="crumb in head" :key="crumb.node.id">
      <ChevronRight :size="16" class="shrink-0 text-text-3" />
      <component
        :is="crumb === crumbs.at(-1) ? 'h1' : 'button'"
        :type="crumb === crumbs.at(-1) ? undefined : 'button'"
        class="mx-2 shrink-0 truncate-safe rounded text-18 font-semibold leading-none"
        :class="[
          crumb !== crumbs.at(-1) && 'text-text-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring',
          drag.overId === crumb.node.id && 'bg-primary-soft text-primary ring-2 ring-primary',
        ]"
        @click="crumb === crumbs.at(-1) ? undefined : go(crumb.parts)"
        @dragover="crumb !== crumbs.at(-1) && onDragOver(crumb.node, $event)"
        @dragleave="onDragLeave(crumb.node)"
        @drop="crumb !== crumbs.at(-1) && onDrop(crumb.node, $event)"
      >
        {{ crumb.node.name }}
      </component>
    </template>

    <template v-if="folded.length">
      <ChevronRight :size="16" class="shrink-0 text-text-3" />
      <IconButton
        :label="t('files.breadcrumbMore')"
        :size="28"
        class="mx-1 text-text-2"
        aria-haspopup="menu"
        @click="openFolded"
      >
        <MoreHorizontal :size="18" />
      </IconButton>
    </template>

    <template v-for="crumb in tail" :key="crumb.node.id">
      <ChevronRight :size="16" class="shrink-0 text-text-3" />
      <component
        :is="crumb === crumbs.at(-1) ? 'h1' : 'button'"
        :type="crumb === crumbs.at(-1) ? undefined : 'button'"
        class="mx-2 min-w-0 truncate-safe rounded text-18 font-semibold leading-none"
        :class="[
          crumb !== crumbs.at(-1) && 'shrink-0 text-text-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring',
          drag.overId === crumb.node.id && 'bg-primary-soft text-primary ring-2 ring-primary',
        ]"
        @click="crumb === crumbs.at(-1) ? undefined : go(crumb.parts)"
        @dragover="crumb !== crumbs.at(-1) && onDragOver(crumb.node, $event)"
        @dragleave="onDragLeave(crumb.node)"
        @drop="crumb !== crumbs.at(-1) && onDrop(crumb.node, $event)"
      >
        {{ crumb.node.name }}
      </component>
    </template>

    <IconButton :label="t('files.subfolders')" :size="24" class="shrink-0 text-text-3" aria-haspopup="menu" @click="openSubfolders">
      <ChevronRight :size="16" />
    </IconButton>

    <FloatingMenu
      v-if="menu"
      :items="menu.items"
      :x="menu.x"
      :y="menu.y"
      :width="MENU_WIDTH"
      :label="menu.label"
      @select="go($event.split('/').filter(Boolean))"
      @close="menu = null"
    />
  </nav>
</template>
