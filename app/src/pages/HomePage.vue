<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { Clock, HardDrive, Star } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useFileActions } from '@/features/files/useFileActions';
import { filesRoute } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { ProgressBar } from '@/ui';
import EmptyState from './files/EmptyState.vue';
import FileCard from './files/FileCard.vue';
import FolderCard from './files/FolderCard.vue';

/** One row of the 236px grid at the 1672 reference width. */
const RECENT_COUNT = 5;

const { t } = useI18n();
const { formatSize } = useFormat();
const files = useFilesStore();
const actions = useFileActions();

const recent = ref<Node[]>([]);
const starred = ref<Node[]>([]);

async function load() {
  [recent.value, starred.value] = await Promise.all([repository.listRecent(), repository.listStarred()]);
  recent.value = recent.value.slice(0, RECENT_COUNT);
}

onMounted(() => {
  // Home keeps its own lists (no selection/sort), so it reloads on the store's mutation counter.
  files.leave();
  void load();
});
watch(() => files.revision, load);
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]">
    <div class="flex h-[38px] items-center">
      <h1 class="text-22 font-semibold leading-none">{{ t('nav.home') }}</h1>
    </div>

    <h2 class="mt-[30px] text-17 font-semibold leading-[26px]">{{ t('home.storages') }}</h2>
    <div class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 336px)">
      <RouterLink
        v-for="storage in files.storages"
        :key="storage.id"
        :to="filesRoute([])"
        class="flex h-[100px] items-center rounded-lg border border-border bg-bg px-5 hover:border-border-hover hover:bg-hover-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
      >
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-primary-soft text-primary">
          <HardDrive :size="22" :stroke-width="1.75" />
        </span>
        <span class="ml-4 min-w-0 flex-1">
          <span class="block truncate-safe text-16 font-medium leading-none">{{ storage.name }}</span>
          <span class="mt-1.5 block text-13 leading-none text-text-3">
            {{ t('quota.used', { used: formatSize(storage.quota.usedBytes), total: formatSize(storage.quota.totalBytes) }) }}
          </span>
          <ProgressBar class="mt-2.5" :value="storage.quota.usedBytes" :max="storage.quota.totalBytes" />
        </span>
      </RouterLink>
    </div>

    <h2 class="mt-[40px] text-17 font-semibold leading-[26px]">{{ t('home.recent') }}</h2>
    <div v-if="recent.length" role="listbox" :aria-label="t('home.recent')" class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 236px)">
      <FileCard v-for="node in recent" :key="node.id" :node="node" :selected="false" @dblclick="actions.open(node)" />
    </div>
    <EmptyState v-else :icon="Clock" :title="t('empty.recent.title')" :hint="t('empty.recent.hint')" class="!py-10" />

    <h2 class="mt-[40px] text-17 font-semibold leading-[26px]">{{ t('home.starred') }}</h2>
    <div v-if="starred.length" role="listbox" :aria-label="t('home.starred')" class="mt-1 grid gap-[14px]" style="grid-template-columns: repeat(auto-fill, 236px)">
      <template v-for="node in starred" :key="node.id">
        <FolderCard v-if="node.kind === 'folder'" :node="node" :selected="false" @dblclick="actions.open(node)" />
        <FileCard v-else :node="node" :selected="false" />
      </template>
    </div>
    <EmptyState v-else :icon="Star" :title="t('empty.starred.title')" :hint="t('empty.starred.hint')" class="!py-10" />
  </main>
</template>
