<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router';
import { ChevronRight, Home, MoreHorizontal } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { filesRoute, segments } from '@/lib/path';
import { useNodeDrag } from '@/features/files/useNodeDrag';
import { useFilesStore } from '@/stores/files';
import { IconButton, Input } from '@/ui';
import FloatingMenu, { anchorBelow, type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

/**
 * Path of the open folder (spec §3): home button, the chain, the current folder in 18/600, then a chevron that
 * descends into its subfolders. A long chain keeps its first and last two crumbs and folds the rest behind "…".
 */
const KEEP_HEAD = 1;
const KEEP_TAIL = 2;
const MENU_WIDTH = 232;

type Crumb = { node: Node; parts: string[]; current: boolean };
/** Stands for the folded middle of a long chain, so one loop draws the whole bar. */
const FOLD = 'fold';

const { t } = useI18n();
const router = useRouter();
const files = useFilesStore();
const { drag, onDragOver, onDragLeave, onDrop } = useNodeDrag();

const menu = ref<{ x: number; y: number; items: FloatingMenuEntry[]; label: string } | null>(null);
/** The bar swapped for a text box: the whole address at once, the way a file manager's address bar is edited. */
const editing = ref(false);
const draft = ref('');
const box = ref<InstanceType<typeof Input>>();

/** Root first, current folder last; every crumb carries the route segments that open it. */
const crumbs = computed<Crumb[]>(() => {
  const chain = [...files.path, files.folder].filter((n) => n !== null);
  return chain.map((node, index) => ({
    node,
    parts: chain.slice(1, index + 1).map((n) => n.name),
    current: index === chain.length - 1,
  }));
});

const folded = computed(() => (crumbs.value.length > KEEP_HEAD + KEEP_TAIL ? crumbs.value.slice(KEEP_HEAD, -KEEP_TAIL) : []));
/** What the bar draws, in order: the kept crumbs with the fold marker where the rest were dropped. */
const shown = computed<(Crumb | typeof FOLD)[]>(() =>
  folded.value.length ? [...crumbs.value.slice(0, KEEP_HEAD), FOLD, ...crumbs.value.slice(-KEEP_TAIL)] : crumbs.value,
);

/**
 * Opens `parts` on `drive`.
 *
 * A click on the crumb of the folder you are ALREADY in is a duplicate navigation, which the router answers by
 * doing nothing at all — so it re-reads the listing instead. The open folder's crumb is a way to ask for it again,
 * not dead text, and that is the only crumb a one-folder chain has to offer.
 */
async function open(drive: string, parts: string[]) {
  const failure = await router.push(filesRoute(drive, parts));
  if (isNavigationFailure(failure, NavigationFailureType.duplicated)) await files.refresh();
}

function go(parts: string[]) {
  menu.value = null;
  if (files.storage) void open(files.storage.id, parts);
}

/** The address the crumbs spell out, in the form the route carries it: `<drive>/<folder>/…`. */
const routePath = computed(() => [files.storage?.id, ...(crumbs.value.at(-1)?.parts ?? [])].filter(Boolean).join('/'));

/** Opened from the page's own button, away from the chain: inside it, one more icon after the trailing chevron read as one more crumb. */
async function edit() {
  menu.value = null;
  draft.value = routePath.value;
  editing.value = true;
  await nextTick();
  box.value?.focus();
}
defineExpose({ edit });

/** The typed address is the route's own `<drive>/<path…>`, so one that resolves nowhere lands on the not-found state. */
function submit() {
  editing.value = false;
  const [drive, ...parts] = segments(draft.value);
  const target = drive ?? files.storage?.id;
  if (target) void open(target, parts);
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
  const children = (await repository.listFolder(current.id)).nodes.filter((n) => n.kind === 'folder');
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
  <nav class="flex min-w-0 items-center" :class="editing && 'flex-1'" :aria-label="t('files.breadcrumb')">
    <Input
      v-if="editing"
      ref="box"
      v-model="draft"
      :height="34"
      class="min-w-0 flex-1"
      :label="t('files.breadcrumbPath')"
      :placeholder="t('files.breadcrumbPath')"
      @enter="submit"
      @keydown.esc="editing = false"
      @focusout="editing = false"
    />

    <template v-else>
      <IconButton :label="t('files.breadcrumbHome')" :size="28" class="text-text-2" @click="go([])"><Home :size="16" /></IconButton>

      <template v-for="crumb in shown" :key="crumb === FOLD ? FOLD : crumb.node.id">
        <ChevronRight :size="14" class="shrink-0 text-text-3" />
        <IconButton
          v-if="crumb === FOLD"
          :label="t('files.breadcrumbMore')"
          :size="24"
          class="mx-0.5 text-text-2"
          aria-haspopup="menu"
          @click="openFolded"
        >
          <MoreHorizontal :size="16" />
        </IconButton>
        <!-- The open folder is the page's heading AND a button: a heading around the button, so it stays both. -->
        <component :is="crumb.current ? 'h1' : 'span'" v-else class="flex min-w-0" :class="!crumb.current && 'shrink-0'">
          <button
            type="button"
            class="min-w-0 truncate-safe rounded px-1.5 py-1 text-13 font-semibold leading-none hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            :class="[
              crumb.current ? 'text-text' : 'text-text-2 hover:text-text',
              drag.overId === crumb.node.id && 'bg-primary-soft text-primary ring-2 ring-primary',
            ]"
            @click="go(crumb.parts)"
            @dragover="!crumb.current && onDragOver(crumb.node, $event)"
            @dragleave="onDragLeave(crumb.node)"
            @drop="!crumb.current && onDrop(crumb.node, $event)"
          >
            {{ crumb.node.name }}
          </button>
        </component>
      </template>

      <IconButton :label="t('files.subfolders')" :size="22" class="shrink-0 text-text-3" aria-haspopup="menu" @click="openSubfolders">
        <ChevronRight :size="14" />
      </IconButton>
    </template>

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
