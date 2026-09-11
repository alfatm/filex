<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { HardDrive, Loader2, SlidersHorizontal, X } from 'lucide-vue-next';
import type { SearchHit } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useFileActions } from '@/features/files/useFileActions';
import ResultRow from '@/features/search/ResultRow.vue';
import { fromUrlQuery, toUrlQuery, useSearchStore } from '@/features/search/searchStore';
import { filesRoute, segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { Button, Select } from '@/ui';

const { t } = useI18n();
const { formatDate } = useFormat();
const route = useRoute();
const router = useRouter();
const store = useSearchStore();
const files = useFilesStore();
const actions = useFileActions();

/**
 * `store.run()` rejects on purpose — a caller that awaits it has to be able to tell — but nothing here awaits it,
 * and an uncaught rejection used to leave the page drawing "No results" for a server that never answered. The
 * failure is in `store.failed`, which is what the page shows; catching keeps it from ALSO surfacing as the
 * app-wide sink's vaguer message.
 */
function search() {
  void store.run().catch(() => undefined);
}

// No folder is open here: "New" lands in the root, and the ⋮ actions (rename, trash) re-run the search.
onMounted(() => files.leave());
watch(() => files.revision, () => {
  if (!blank.value) search();
});

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
  // The same wording the listing chip carries, so one filter reads the same on both pages.
  if (q.around) out.push(t(`filter.around.${q.around.field}`, { date: formatDate(q.around.at), span: t(`filter.around.spanOf.${q.around.span}`) }));
  if (q.fileType !== 'any') out.push(t(`search.typeOptions.${q.fileType}`));
  if (q.tags.length) out.push(t('search.chipTags', { tags: q.tags.join(', ') }));
  if (q.size.preset !== 'any') out.push(t(`search.sizeOptions.${q.size.preset}`));
  if (q.path) out.push(t('search.chipPath', { path: q.path }));
  return out;
});

/**
 * The folders left out, as removable chips. They are the only chips here that can be TAKEN OFF in place, and they
 * have to be: nothing counts what an exclusion removed — the engine never returns those documents — so these
 * chips are the whole record of why a result list is shorter than it looks like it should be. A list emptied by
 * an exclusion has to read as an exclusion and not as a query that found nothing.
 */
const exclusions = computed(() => store.query.excludePaths.map((p) => ({ path: p, label: `/${p}` })));

/** Adding and removing go through the URL, like every other change to this query: the page runs what the URL says. */
function skipFolder(folderPath: string) {
  if (!folderPath || store.query.excludePaths.includes(folderPath)) return;
  void apply([...store.query.excludePaths, folderPath]);
}

function unskipFolder(folderPath: string) {
  void apply(store.query.excludePaths.filter((p) => p !== folderPath));
}

function apply(excludePaths: string[]) {
  return router.push({ name: 'search', query: toUrlQuery({ ...store.query, excludePaths }) });
}

/**
 * Which drive answers: every one the account can see, or one of them.
 *
 * It is a real narrowing, not a sieve over the page — the drive travels as `storage_id` and the count that comes
 * back is the count for that drive. A drive whose row id the server did not send cannot narrow anything, so it is
 * offered disabled rather than silently widening the search back to everything.
 */
const driveOptions = computed(() => [
  { value: '', label: t('search.allDrives') },
  ...files.storages.map((s) => ({ value: s.id, label: s.name, disabled: !s.serverId })),
]);

const drive = computed({
  get: () => store.query.drive ?? '',
  set: (value: string) => {
    // "Current folder" already names a folder on one drive. Two controls quietly overriding each other is the
    // contradiction the Path box and this scope already had to be taught not to have, so picking a drive widens
    // the scope to that whole drive instead of leaving a folder scope that means something else now.
    const searchIn = value && store.query.searchIn === 'current' ? 'all' : store.query.searchIn;
    void router.push({ name: 'search', query: toUrlQuery({ ...store.query, drive: value || null, searchIn }) });
  },
});

/** Nothing typed and no filter set — `/search` bare, which is where clearing the top bar's box lands. */
const blank = computed(() => Object.keys(toUrlQuery(store.query)).length === 0);

// The URL owns the query: `/search?q=…` is the shareable form of the store state.
watch(
  () => route.query,
  (raw) => {
    if (route.name !== 'search') return;
    store.assign(fromUrlQuery(raw));
    // A blank query is not a search that found nothing; it is no search at all, so the page drops the previous
    // answer rather than asking the server for everything.
    if (blank.value) store.clearResults();
    else search();
  },
  { immediate: true },
);

function open(hit: SearchHit) {
  // Files preview in place, ← → walking the result rows; `folderPath` is relative to the storage root, which is
  // what the files route's segments are.
  if (hit.node.kind === 'file') actions.preview(hit.node, store.hits.map((h) => h.node));
  else void router.push(filesRoute(hit.storageId, [...segments(hit.folderPath), hit.node.name]));
}
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-6 pl-4 pr-3 pt-3">
    <div class="flex min-h-control-md flex-wrap items-center gap-x-2 gap-y-2 pl-2">
      <h1 class="text-18 font-semibold leading-none">{{ t('search.resultsTitle') }}</h1>
      <ul class="flex flex-wrap items-center gap-2">
        <li v-for="chip in chips" :key="chip" class="flex h-7 items-center rounded-full bg-primary-soft px-3 text-11.5 leading-none text-primary-strong">
          {{ chip }}
        </li>
      </ul>
      <ul v-if="exclusions.length" class="flex flex-wrap items-center gap-2">
        <li v-for="chip in exclusions" :key="chip.path" class="flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-3 pr-1 text-11.5 leading-none text-primary-strong">
          <span>{{ t('search.chipSkip', { path: chip.label }) }}</span>
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded-full hover:bg-primary-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            :aria-label="t('search.unskipFolder', { folder: chip.label })"
            @click="unskipFolder(chip.path)"
          >
            <X :size="12" />
          </button>
        </li>
      </ul>
      <span v-if="!blank" class="ml-auto mr-2 text-13 leading-none text-text-3" aria-live="polite">{{
        t(store.capped ? 'search.matchingMore' : 'search.matching', store.total)
      }}</span>
      <Select v-model="drive" :options="driveOptions" :icon="HardDrive" :width="176" :label="t('search.drive')" />
      <!-- Reopens Advanced search on the query behind these chips, so a result set can be narrowed in place. -->
      <Button variant="outline" class="mr-[9px] gap-2" @click="store.openModal()">
        <SlidersHorizontal :size="16" />
        <span>{{ t('search.refine') }}</span>
      </Button>
    </div>

    <!--
      `aria-busy` on the region, not a spinner alone: a slow query used to leave the previous answer on screen with
      nothing saying a new one was on the way (measured at 2.5 s — no spinner, no busy flag, no line of text).
      The rows are kept rather than blanked, so what is there stays readable while the newer answer is fetched.
    -->
    <div class="mr-[9px] mt-3" :aria-busy="store.loading">
      <p v-if="store.loading" class="flex items-center gap-2 py-2 pl-3 text-13 leading-none text-text-3" role="status">
        <Loader2 :size="14" class="animate-spin" />
        <span>{{ t('search.searching') }}</span>
      </p>
      <table class="w-full table-fixed border-collapse">
        <colgroup>
          <col v-for="col in columns" :key="col.id" :style="'width' in col ? { width: `${col.width}px` } : undefined" />
          <col style="width: 60px" />
        </colgroup>
        <thead>
          <tr class="h-[30px] border-b border-border text-12 leading-none text-text-2 [&>th]:p-0">
            <th v-for="col in columns" :key="col.id" class="text-left font-normal" :class="col.id === 'colName' && '!pl-3'">
              {{ t(`search.${col.id}`) }}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          <ResultRow v-for="hit in store.hits" :key="hit.node.id" :hit="hit" @open="open" @skip="skipFolder" />
        </tbody>
      </table>
      <p v-if="store.failed" class="mt-40 text-center text-13 text-danger" role="alert">{{ t('search.failed') }}</p>
      <p v-else-if="!store.hits.length && !store.loading" class="mt-40 text-center text-13 text-text-3">
        {{ t(blank ? 'search.blankQuery' : 'search.noResults') }}
      </p>
    </div>
  </main>
</template>
