<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { SlidersHorizontal } from 'lucide-vue-next';
import type { SearchHit } from '@/data/types';
import { useFileActions } from '@/features/files/useFileActions';
import ResultRow from '@/features/search/ResultRow.vue';
import { fromUrlQuery, useSearchStore } from '@/features/search/searchStore';
import { filesRoute, segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { Button } from '@/ui';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useSearchStore();
const files = useFilesStore();
const actions = useFileActions();

// No folder is open here: "New" lands in the root, and the ⋮ actions (rename, trash) re-run the search.
onMounted(() => files.leave());
watch(
  () => files.revision,
  () => void store.run(),
);

// Spec §4 widths for the shared columns; path and match split the remaining space.
const columns = [
  { id: 'colName', width: 340 },
  { id: 'colPath', width: 200 },
  { id: 'colMatch' },
  { id: 'colModified', width: 236 },
  { id: 'colSize', width: 120 },
] as const;

const chips = computed(() => {
  const q = store.query;
  const out: string[] = [];
  if (q.text) out.push(t('search.chipQuery', { text: q.text }));
  if (q.scope !== 'all') out.push(t(`search.scope.${q.scope}`));
  if (q.searchIn !== 'current') out.push(t(`search.in.${q.searchIn}`));
  if (q.modified !== 'any') out.push(t(`search.modifiedOptions.${q.modified}`));
  if (q.fileType !== 'any') out.push(t(`search.typeOptions.${q.fileType}`));
  if (q.tags.length) out.push(t('search.chipTags', { tags: q.tags.join(', ') }));
  if (q.size.preset !== 'any') out.push(t(`search.sizeOptions.${q.size.preset}`));
  if (q.path) out.push(t('search.chipPath', { path: q.path }));
  return out;
});

// The URL owns the query: `/search?q=…` is the shareable form of the store state.
watch(
  () => route.query,
  (raw) => {
    if (route.name !== 'search') return;
    store.assign(fromUrlQuery(raw));
    void store.run();
  },
  { immediate: true },
);

function open(hit: SearchHit) {
  // Files preview in place, ← → walking the result rows; `folderPath` is relative to the storage root, which is
  // what the files route's segments are.
  if (hit.node.kind === 'file') actions.preview(hit.node, store.hits.map((h) => h.node));
  else void router.push(filesRoute([...segments(hit.folderPath), hit.node.name]));
}
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]">
    <div class="flex min-h-[38px] flex-wrap items-center gap-x-3 gap-y-2 pl-[11px]">
      <h1 class="text-22 font-semibold leading-none">{{ t('search.resultsTitle') }}</h1>
      <ul class="flex flex-wrap items-center gap-2">
        <li v-for="chip in chips" :key="chip" class="flex h-7 items-center rounded-full bg-primary-soft px-3 text-14 leading-none text-primary">
          {{ chip }}
        </li>
      </ul>
      <span class="ml-auto text-15 leading-none text-text-3" aria-live="polite">{{ t('search.matching', store.total) }}</span>
      <!-- Reopens Advanced search on the query behind these chips, so a result set can be narrowed in place. -->
      <Button variant="outline" class="mr-[9px] gap-2" @click="store.openModal()">
        <SlidersHorizontal :size="16" />
        <span>{{ t('search.refine') }}</span>
      </Button>
    </div>

    <div class="mr-[9px] mt-[22px]">
      <table class="w-full table-fixed border-collapse">
        <colgroup>
          <col v-for="col in columns" :key="col.id" :style="'width' in col ? { width: `${col.width}px` } : undefined" />
          <col style="width: 60px" />
        </colgroup>
        <thead>
          <tr class="h-[38px] border-b border-border text-15 leading-none text-text-2 [&>th]:p-0">
            <th v-for="col in columns" :key="col.id" class="text-left font-normal" :class="col.id === 'colName' && '!pl-3'">
              {{ t(`search.${col.id}`) }}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          <ResultRow v-for="hit in store.hits" :key="hit.node.id" :hit="hit" @open="open" />
        </tbody>
      </table>
      <p v-if="!store.hits.length && !store.loading" class="mt-40 text-center text-16 text-text-3">{{ t('search.noResults') }}</p>
    </div>
  </main>
</template>
