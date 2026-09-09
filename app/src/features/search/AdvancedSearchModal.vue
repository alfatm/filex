<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import {
  Calendar,
  File,
  FileText,
  Folder,
  HelpCircle,
  RotateCcw,
  Search,
  Tag,
  User,
  X,
} from 'lucide-vue-next';
import {
  FILE_TYPE_GROUPS,
  MODIFIED_PRESETS,
  SEARCH_INS,
  SEARCH_SCOPES,
  SIZE_PRESETS,
  SIZE_UNITS,
  type SearchScope,
} from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { Button, Checkbox, IconButton, Input, Radio, Select } from '@/ui';
import HitIcon from './HitIcon.vue';
import Snippet from './Snippet.vue';
import { fromUrlQuery, hitFolderLabel, toUrlQuery, useSearchStore } from './searchStore';

const LIVE_ROWS = 3;
const DEBOUNCE_MS = 250;
/**
 * One box, because one is all the index can answer. Case sensitivity is decided when a document is INDEXED — the
 * analyser lowercases every token — so a case-sensitive query would have to sieve the answer, and on a common word
 * it would report "nothing" while the matches sat past the window. OCR is not a query option either: where the
 * server has `tesseract`, text recognised in images is part of a document's content already and is searched like
 * any other text, so a switch could only ever turn OFF something the user has no reason to turn off.
 */
const CONTENT_OPTIONS = ['wholePhrase'] as const;
const ARROW_STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const { t } = useI18n();
const { formatDate, formatSize } = useFormat();
const route = useRoute();
const router = useRouter();
const files = useFilesStore();
const store = useSearchStore();
const { query } = store;

const queryInput = ref<InstanceType<typeof Input>>();
const scopeGroup = ref<HTMLElement>();
const tagDraft = ref('');
const searchInId = useId();

const SCOPE_ICONS: Record<SearchScope, typeof FileText> = { all: FileText, content: FileText, paths: Folder, tags: Tag };
// The label follows the query's own folder (set from the files route on open), not the files store, which is stale off that route.
const folderName = computed(() => segments(query.folderPath).at(-1) ?? files.storage?.name ?? '');
const modifiedOptions = computed(() => MODIFIED_PRESETS.map((value) => ({ value, label: t(`search.modifiedOptions.${value}`) })));
const typeOptions = computed(() => FILE_TYPE_GROUPS.map((value) => ({ value, label: t(`search.typeOptions.${value}`) })));
const sizeOptions = computed(() => SIZE_PRESETS.map((value) => ({ value, label: t(`search.sizeOptions.${value}`) })));
const unitOptions = computed(() => SIZE_UNITS.map((value) => ({ value, label: t(`unit.${value.toLowerCase()}`) })));
const ownerOptions = computed(() => [
  { value: '', label: t('search.anyOwner') },
  ...(files.user ? [{ value: files.user.id, label: t('search.ownerYou') }] : []),
]);

const owner = computed({
  get: () => query.ownerId ?? '',
  set: (value: string) => (query.ownerId = value || null),
});
function sizeBound(key: 'min' | 'max') {
  return computed({
    get: () => (query.size[key] === null ? '' : String(query.size[key])),
    // A number input hands v-model a number, a cleared one an empty string.
    set: (value: string | number) => {
      const parsed = Number(value);
      query.size[key] = String(value).trim() === '' || !Number.isFinite(parsed) ? null : parsed;
    },
  });
}

async function onScopeKeydown(event: KeyboardEvent) {
  const step = ARROW_STEP[event.key];
  if (!step) return;
  event.preventDefault();
  const at = SEARCH_SCOPES.indexOf(query.scope);
  query.scope = SEARCH_SCOPES[(at + step + SEARCH_SCOPES.length) % SEARCH_SCOPES.length];
  await nextTick();
  scopeGroup.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
}
const sizeMin = sizeBound('min');
const sizeMax = sizeBound('max');

function addTag() {
  const tag = tagDraft.value.trim();
  if (tag && !query.tags.includes(tag)) query.tags.push(tag);
  tagDraft.value = '';
}
function removeTag(tag: string) {
  query.tags = query.tags.filter((item) => item !== tag);
}

let timer: ReturnType<typeof setTimeout> | undefined;

function submit() {
  clearTimeout(timer);
  store.close();
  void router.push({ name: 'search', query: toUrlQuery(query) });
}

// The live preview edits the store the results page also shows; leaving without searching puts the URL's query back.
function cancel() {
  clearTimeout(timer);
  store.close();
  if (route.name !== 'search') return;
  store.assign(fromUrlQuery(route.query));
  void store.run();
}

// Live results follow the form with a short debounce; the first run after opening is immediate.
watch(
  () => [store.open, JSON.stringify(query)] as const,
  ([open], previous) => {
    clearTimeout(timer);
    if (!open) return;
    if (previous?.[0]) timer = setTimeout(() => void store.run(), DEBOUNCE_MS);
    else void store.run();
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const liveHits = computed(() => store.hits.slice(0, LIVE_ROWS));
</script>

<template>
  <Dialog :open="store.open" :initial-focus="queryInput?.el" class="relative z-40" @close="cancel">
    <div class="fixed inset-0 bg-overlay" aria-hidden="true" />
    <div class="fixed inset-0 overflow-y-auto">
      <DialogPanel
        class="absolute left-1/2 top-[62px] ml-px w-[722px] -translate-x-1/2 rounded-2xl bg-bg px-[26px] pb-[22px] pt-[26px] shadow-modal"
      >
        <div class="flex items-center">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Search :size="18" />
          </span>
          <div class="ml-3.5">
            <DialogTitle class="text-20 font-semibold leading-none">{{ t('search.title') }}</DialogTitle>
            <p class="mt-1 text-14 leading-[21px] text-text-3">{{ t('search.subtitle') }}</p>
          </div>
          <IconButton :label="t('search.close')" class="ml-auto -mr-2 -mt-2 self-start" @click="cancel">
            <X :size="22" />
          </IconButton>
        </div>

        <Input
          ref="queryInput"
          v-model="query.text"
          class="mt-[15px]"
          type="search"
          :height="44"
          :icon="Search"
          :placeholder="t('search.placeholder')"
          :label="t('search.search')"
          @enter="submit"
        />

        <div
          ref="scopeGroup"
          role="radiogroup"
          :aria-label="t('search.scopeLabel')"
          class="mt-[18px] flex h-[42px] divide-x divide-border rounded-md bg-bg-muted p-[3px]"
          @keydown="onScopeKeydown"
        >
          <button
            v-for="scope in SEARCH_SCOPES"
            :key="scope"
            type="button"
            role="radio"
            :aria-checked="query.scope === scope"
            :tabindex="query.scope === scope ? 0 : -1"
            class="flex flex-1 items-center justify-center gap-2 rounded text-15 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            :class="query.scope === scope ? 'bg-primary-soft text-primary' : 'text-text-2 hover:text-text'"
            @click="query.scope = scope"
          >
            <component :is="SCOPE_ICONS[scope]" :size="18" />
            <span>{{ t(`search.scope.${scope}`) }}</span>
          </button>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-x-[35px]">
          <!-- Left column -->
          <div class="flex flex-col gap-[18px]">
            <section>
              <h3 :id="searchInId" class="flex h-5 items-center gap-1.5 text-15 font-semibold leading-none">
                {{ t('search.searchIn') }}
                <HelpCircle :size="14" class="text-text-3" :aria-label="t('search.searchInHelp')" role="img">
                  <title>{{ t('search.searchInHelp') }}</title>
                </HelpCircle>
              </h3>
              <div role="radiogroup" :aria-labelledby="searchInId" class="mt-2 flex flex-col gap-2">
                <Radio
                  v-for="option in SEARCH_INS"
                  :key="option"
                  v-model="query.searchIn"
                  :value="option"
                  :label="t(`search.in.${option}`, { folder: folderName })"
                />
              </div>
            </section>
            <section>
              <h3 class="flex h-5 items-center text-15 font-semibold leading-none">{{ t('search.modified') }}</h3>
              <Select v-model="query.modified" class="mt-2" :options="modifiedOptions" :icon="Calendar" :label="t('search.modified')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-15 font-semibold leading-none">{{ t('search.fileType') }}</h3>
              <Select v-model="query.fileType" class="mt-2" :options="typeOptions" :icon="File" :label="t('search.fileType')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-15 font-semibold leading-none">{{ t('search.tags') }}</h3>
              <Input v-model="tagDraft" class="mt-2" :placeholder="t('search.tagsPlaceholder')" :label="t('search.tags')" @enter="addTag" />
              <ul v-if="query.tags.length" class="mt-2 flex flex-wrap gap-2">
                <li
                  v-for="tag in query.tags"
                  :key="tag"
                  class="flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-3 pr-2 text-14 leading-none text-primary"
                >
                  <span>{{ tag }}</span>
                  <button type="button" class="flex h-4 w-4 items-center justify-center rounded-full hover:bg-white/60" :aria-label="t('search.removeTag', { tag })" @click="removeTag(tag)">
                    <X :size="14" />
                  </button>
                </li>
              </ul>
            </section>
          </div>

          <!-- Right column -->
          <div class="flex flex-col gap-[18px]">
            <section>
              <h3 class="flex h-5 items-center text-15 font-semibold leading-none">{{ t('search.owner') }}</h3>
              <Select v-model="owner" class="mt-2" :options="ownerOptions" :icon="User" :label="t('search.owner')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-15 font-semibold leading-none">{{ t('search.sizeRange') }}</h3>
              <div class="mt-2 flex items-center gap-1.5">
                <Select v-model="query.size.preset" :options="sizeOptions" :width="94" dense :label="t('search.sizeRange')" />
                <Input v-model="sizeMin" type="number" :width="64" :placeholder="t('search.min')" :label="t('search.min')" @enter="submit" />
                <span class="text-15 leading-none text-text-3">–</span>
                <Input v-model="sizeMax" type="number" :width="64" :placeholder="t('search.max')" :label="t('search.max')" @enter="submit" />
                <Select v-model="query.size.unit" :options="unitOptions" :width="62" dense :label="t('search.unit')" />
              </div>
            </section>
            <section>
              <h3 class="flex h-5 items-center gap-1.5 text-15 font-semibold leading-none">
                {{ t('search.path') }}
                <HelpCircle :size="14" class="text-text-3" :aria-label="t('search.pathHelp')" role="img">
                  <title>{{ t('search.pathHelp') }}</title>
                </HelpCircle>
              </h3>
              <Input v-model="query.path" class="mt-2" :placeholder="t('search.pathHint')" :label="t('search.path')" @enter="submit" />
              <p class="mt-1 text-13 leading-none text-text-3">{{ t('search.pathHint') }}</p>
            </section>
            <section>
              <h3 class="flex h-5 items-center gap-2 text-15 font-semibold leading-none">
                <FileText :size="18" class="text-text-2" />
                {{ t('search.contentOptions') }}
              </h3>
              <div class="mt-3 flex flex-col gap-3">
                <Checkbox v-for="option in CONTENT_OPTIONS" :key="option" v-model="query[option]" :label="t(`search.${option}`)" show-label />
              </div>
            </section>
          </div>
        </div>

        <div class="mt-3 h-px bg-border" />

        <div class="mt-[14px] flex h-[26px] items-center justify-between">
          <h3 class="text-17 font-semibold leading-none" aria-live="polite">{{ t(store.capped ? 'search.matchingMore' : 'search.matching', store.total) }}</h3>
          <button type="button" class="text-14 leading-none text-primary hover:underline" @click="submit">{{ t('search.viewAll') }}</button>
        </div>

        <ul class="mt-2" :aria-busy="store.loading">
          <li v-for="hit in liveHits" :key="hit.node.id" class="flex h-9 items-center leading-none">
            <span class="flex w-6 shrink-0 justify-center"><HitIcon :node="hit.node" :size="24" /></span>
            <span class="ml-[26px] min-w-[72px] truncate text-15 font-medium">{{ hit.node.name }}</span>
            <span class="ml-2 shrink-0 text-13 text-text-3">{{ hitFolderLabel(hit, files.storages) }}</span>
            <span class="min-w-0 flex-1 truncate px-4 text-center text-13 text-text-3">
              <Snippet v-if="hit.snippet" :text="hit.snippet.text" :ranges="hit.snippet.ranges" />
            </span>
            <span class="shrink-0 text-13 text-text-3">
              {{ hit.node.kind === 'folder' ? t('search.updated', { date: formatDate(hit.node.modifiedAt) }) : formatDate(hit.node.modifiedAt) }}
            </span>
            <span class="ml-4 w-14 shrink-0 text-right text-13">
              {{ hit.node.kind === 'folder' ? (hit.node.itemCount === undefined ? t('type.folder') : t('files.items', hit.node.itemCount)) : formatSize(hit.node.size) }}
            </span>
          </li>
          <li v-if="!liveHits.length && !store.loading" class="flex h-9 items-center text-15 text-text-3">{{ t('search.noResults') }}</li>
        </ul>

        <div class="mt-[25px] flex items-center">
          <Button variant="outline" class="!h-11 w-[104px]" @click="store.reset()">
            <RotateCcw :size="18" />
            {{ t('search.reset') }}
          </Button>
          <Button variant="outline" class="ml-auto !h-11 w-[94px]" @click="cancel">{{ t('search.cancel') }}</Button>
          <Button class="ml-4 !h-11 w-[122px]" @click="submit">
            <Search :size="18" />
            {{ t('search.search') }}
          </Button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
