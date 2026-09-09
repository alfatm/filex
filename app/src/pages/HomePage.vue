<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { AlertTriangle, Clock, HardDrive, Info, Star } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useFileActions } from '@/features/files/useFileActions';
import { useListingKeyboard } from '@/features/files/useListingKeyboard';
import { filesRoute } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Button, IconButton, ProgressBar } from '@/ui';
import DetailsPanel from './files/DetailsPanel.vue';
import EmptyState from './files/EmptyState.vue';
import FileCard from './files/FileCard.vue';
import FolderCard from './files/FolderCard.vue';

/** One row of the 236px grid at the 1672 reference width. */
const RECENT_COUNT = 5;

const { t } = useI18n();
const { formatSize } = useFormat();
const files = useFilesStore();
const view = useViewStore();
const actions = useFileActions();
const { onMainClick } = useListingKeyboard();

const recent = ref<Node[]>([]);
const starred = ref<Node[]>([]);
/**
 * The lists never arrived. It is a state of its own for the same reason `files.bootstrap` has one: "No recent
 * files" is a sentence about an account, and drawing it because nobody answered says something untrue.
 */
const failed = ref(false);

async function load() {
  let lists: [Node[], Node[]];
  try {
    lists = await Promise.all([repository.listRecent(), repository.listStarred()]);
  } catch {
    failed.value = true;
    recent.value = [];
    starred.value = [];
    files.items = [];
    return;
  }
  failed.value = false;
  [recent.value, starred.value] = lists;
  recent.value = recent.value.slice(0, RECENT_COUNT);
  // The store resolves selected ids against its own list, so Home hands it the nodes it shows — without that the
  // click selects an id that resolves to nothing and the details panel has no node. A node can be both recent and
  // starred, and a duplicate id would resolve to two nodes, which reads as a multi-selection.
  files.items = [...new Map([...recent.value, ...starred.value].map((node) => [node.id, node])).values()];
}

onMounted(() => {
  // Home keeps its own lists (its own order, its own 5-item cap), so it reloads on the store's mutation counter.
  files.leave();
  void load();
});
watch(() => files.revision, load);
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]" @click="onMainClick">
    <div class="flex h-[38px] items-center">
      <h1 class="text-22 font-semibold leading-none">{{ t('nav.home') }}</h1>
      <!-- Same toggle as the listings: a card picked here describes a node like any other. -->
      <IconButton :label="t('files.details')" variant="outline" :active="view.detailsOpen" class="ml-auto mr-[10px] !w-11" @click="view.togglePanel('details')">
        <Info :size="20" />
      </IconButton>
    </div>

    <!-- The home drive is "My files" in the sidebar; the cards are for the drives mounted beside it, if any. -->
    <template v-if="files.listedStorages.length">
      <h2 class="mt-[30px] text-17 font-semibold leading-[26px]">{{ t('home.storages') }}</h2>
      <div class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 336px)">
        <RouterLink
          v-for="storage in files.listedStorages"
          :key="storage.id"
          :to="filesRoute(storage.id, [])"
          class="flex h-[100px] items-center rounded-lg border border-border bg-bg px-5 hover:border-border-hover hover:bg-hover-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        >
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-primary-soft text-primary">
            <HardDrive :size="22" :stroke-width="1.75" />
          </span>
          <span class="ml-4 min-w-0 flex-1">
            <span class="block truncate-safe text-16 font-medium leading-none">{{ storage.name }}</span>
            <span class="mt-1.5 block text-13 leading-none text-text-3">
              {{
                storage.quota.totalBytes
                  ? t('quota.used', { used: formatSize(storage.quota.usedBytes), total: formatSize(storage.quota.totalBytes) })
                  : t('quota.usedUnlimited', { used: formatSize(storage.quota.usedBytes) })
              }}
            </span>
            <!-- Same rule as the sidebar: an account with no ceiling gets the figure without a bar that cannot fill. -->
            <ProgressBar
              v-if="storage.quota.totalBytes"
              class="mt-2.5"
              :value="storage.quota.usedBytes"
              :max="storage.quota.totalBytes"
            />
          </span>
        </RouterLink>
      </div>
    </template>

    <EmptyState v-if="failed" class="mt-24" :icon="AlertTriangle" :title="t('error.load.title')" :hint="t('error.load.hint')">
      <Button variant="outline" @click="load()">{{ t('error.retry') }}</Button>
    </EmptyState>

    <template v-else>
      <h2 class="mt-[40px] text-17 font-semibold leading-[26px]">{{ t('home.recent') }}</h2>
      <div v-if="recent.length" role="listbox" :aria-label="t('home.recent')" class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 236px)">
        <FileCard
          v-for="node in recent"
          :key="node.id"
          :node="node"
          :selected="files.isSelected(node.id)"
          :focused="files.cursorId === node.id"
          @click="files.selectFromEvent(node.id, $event)"
          @dblclick="actions.open(node)"
          @focus="files.focusedId = node.id"
        />
      </div>
      <EmptyState v-else :icon="Clock" :title="t('empty.recent.title')" :hint="t('empty.recent.hint')" class="!py-10" />

      <h2 class="mt-[40px] text-17 font-semibold leading-[26px]">{{ t('home.starred') }}</h2>
      <div v-if="starred.length" role="listbox" :aria-label="t('home.starred')" class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 236px)">
        <template v-for="node in starred" :key="node.id">
          <FolderCard
            v-if="node.kind === 'folder'"
            :node="node"
            :selected="files.isSelected(node.id)"
            :focused="files.cursorId === node.id"
            @click="files.selectFromEvent(node.id, $event)"
            @dblclick="actions.open(node)"
            @focus="files.focusedId = node.id"
          />
          <FileCard
            v-else
            :node="node"
            :selected="files.isSelected(node.id)"
            :focused="files.cursorId === node.id"
            @click="files.selectFromEvent(node.id, $event)"
            @dblclick="actions.open(node)"
            @focus="files.focusedId = node.id"
          />
        </template>
      </div>
      <EmptyState v-else :icon="Star" :title="t('empty.starred.title')" :hint="t('empty.starred.hint')" class="!py-10" />
    </template>
  </main>

  <!-- Home has no folder of its own, so the panel appears only once a card is picked. -->
  <DetailsPanel
    v-if="view.detailsOpen && files.selected.length === 1 && files.focusNode"
    :node="files.focusNode"
    :path="files.focusPath"
    :people="files.people"
    :user="files.user"
    @close="view.detailsOpen = false"
  />
</template>
