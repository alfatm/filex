<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import {
  HardDrive,
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
  AROUND_SPANS,
  FILE_TYPE_GROUPS,
  MODIFIED_PRESETS,
  SEARCH_INS,
  SEARCH_SCOPES,
  SIZE_PRESETS,
  SIZE_UNITS,
  type AroundSpan,
  type DateWindow,
  type SearchScope,
} from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { segments } from '@/lib/path';
import { repository } from '@/data';
import { NOT_FOUND } from '@/data/repository';
import { errorMessage } from '@/lib/errors';
import { useFilesStore } from '@/stores/files';
import { Button, Checkbox, IconButton, Input, Radio, Select } from '@/ui';
import Segmented from '@/features/settings/Segmented.vue';
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
const aroundFieldOptions = computed(() =>
  (['modified', 'created'] as const).map((value) => ({ value, label: t(`filter.around.field.${value}`) })),
);
const aroundSpanOptions = computed(() => AROUND_SPANS.map((value) => ({ value, label: t(`filter.around.span.${value}`) })));

/**
 * The date window, as the listing chips and the details panel set it — and the only way to ask about the CREATION
 * date, which the presets above do not reach.
 *
 * The box takes a DAY and the window is centred on its noon, so "±1 day" covers that day and a night either side
 * rather than starting at midnight and ending at the next. A window that arrived with an exact moment (from a
 * property click, through the URL) keeps it until the box is edited.
 */
const aroundDate = computed({
  get: () => (query.around ? localDay(query.around.at) : ''),
  set: (day: string | number) => {
    const value = String(day);
    if (!value) {
      query.around = null;
      return;
    }
    const at = new Date(`${value}T12:00:00`);
    if (Number.isNaN(at.getTime())) return;
    query.around = { field: query.around?.field ?? 'modified', at: at.toISOString(), span: query.around?.span ?? 'day' };
    // Two windows over one column is a question nothing can be inside, so the preset steps aside.
    query.modified = 'any';
  },
});
const aroundField = computed({
  get: () => query.around?.field ?? 'modified',
  set: (field: DateWindow['field']) => {
    if (query.around) query.around = { ...query.around, field };
  },
});
const aroundSpan = computed({
  get: () => query.around?.span ?? 'day',
  set: (span: AroundSpan) => {
    if (query.around) query.around = { ...query.around, span };
  },
});
/** The preset and the window are the same question asked twice; picking one drops the other. */
const modifiedPreset = computed({
  get: () => query.modified,
  set: (value: (typeof MODIFIED_PRESETS)[number]) => {
    query.modified = value;
    if (value !== 'any') query.around = null;
  },
});

/** `YYYY-MM-DD` in the reader's own zone, which is what a date input takes and what the person saw on the row. */
function localDay(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
const typeOptions = computed(() => FILE_TYPE_GROUPS.map((value) => ({ value, label: t(`search.typeOptions.${value}`) })));
// The hint says what the box MEANS, not what it looks like: a path box that reads the opposite way depending on a
// control above it has to spell out which way it is reading, or the control is decoration.
/**
 * Which drive answers, as the results page offers it (§7b). Picking one while the scope is "Current folder"
 * widens the scope to that whole drive: the folder scope names a folder on ONE drive, so leaving both standing
 * would be two controls describing different places at once.
 */
const driveOptions = computed(() => [
  { value: '', label: t('search.allDrives') },
  ...files.storages.map((s) => ({ value: s.id, label: s.name, disabled: !s.serverId })),
]);

const drive = computed({
  get: () => query.drive ?? '',
  set: (value: string) => {
    query.drive = value || null;
    if (value && query.searchIn === 'current') query.searchIn = 'all';
  },
});

const pathModeOptions = computed(() => [
  { value: 'only' as const, label: t('search.pathModeOnly') },
  { value: 'skip' as const, label: t('search.pathModeSkip') },
]);
const pathHint = computed(() => (query.pathMode === 'skip' ? t('search.pathHintSkip') : t('search.pathHintOnly')));

/**
 * Whether the folder in the Path box exists, checked when the box is left.
 *
 * A path that names nothing is invisible in a result list: confining to it answers with nothing, which reads as
 * "this search found nothing", and EXCLUDING it removes nothing at all, which reads as a filter that did not
 * work — and no count says otherwise, since nothing counts what an exclusion removed.
 *
 * On leaving the box, not on every keystroke: half a typed path names nothing on the way to naming something, so
 * a live check would spend a request per character to call a person wrong while they are still typing.
 *
 * Only the server SAYING the folder is not there becomes `missing`. A request that failed to reach it leaves the
 * hint alone: "no such folder" is a claim about the drive, and an unreachable server has not made one.
 */
type PathCheck = 'idle' | 'checking' | 'ok' | 'missing' | 'unknownDrive';
const pathCheck = ref<PathCheck>('idle');
let pathSeq = 0;

watch(() => query.path, () => {
  pathSeq += 1;
  pathCheck.value = 'idle';
});

async function checkPath() {
  const [drive, ...under] = query.path.split('/').filter(Boolean);
  const id = ++pathSeq;
  if (!drive) return void (pathCheck.value = 'idle');
  // The drive is answered without asking anything: the app already holds every drive this account can open.
  if (!files.storages.some((s) => s.id === drive)) return void (pathCheck.value = 'unknownDrive');
  if (!under.length) return void (pathCheck.value = 'ok');
  pathCheck.value = 'checking';
  try {
    await repository.resolvePath(drive, under.join('/'));
    if (id === pathSeq) pathCheck.value = 'ok';
  } catch (error) {
    if (id !== pathSeq) return;
    pathCheck.value = errorMessage(error) === NOT_FOUND ? 'missing' : 'idle';
  }
}

const pathProblem = computed(() => {
  if (pathCheck.value === 'missing') return t('search.pathMissing');
  if (pathCheck.value === 'unknownDrive') return t('search.pathUnknownDrive');
  return '';
});

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

/** As on the results page: the failure is `store.failed`, shown below the count, not an uncaught rejection. */
function search() {
  void store.run().catch(() => undefined);
}

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
  search();
}

// Live results follow the form with a short debounce; the first run after opening is immediate.
watch(
  () => [store.open, JSON.stringify(query)] as const,
  ([open], previous) => {
    clearTimeout(timer);
    if (!open) return;
    if (previous?.[0]) timer = setTimeout(search, DEBOUNCE_MS);
    else search();
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
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-strong">
            <Search :size="18" />
          </span>
          <div class="ml-3.5">
            <DialogTitle class="text-17 font-semibold leading-none">{{ t('search.title') }}</DialogTitle>
            <p class="mt-1 text-11.5 leading-[21px] text-text-3">{{ t('search.subtitle') }}</p>
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
          :suggestions="store.history.queries"
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
            class="flex flex-1 items-center justify-center gap-2 rounded text-13 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
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
              <h3 :id="searchInId" class="flex h-5 items-center gap-1.5 text-13 font-semibold leading-none">
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
              <!-- The same drive picker the results page carries (§7b), in the section that already answers
                   "where". Without it the form could show a drive it could not change: the value rides through
                   Refine untouched, so the box would have been the only control in here that only reads. -->
              <Select v-model="drive" class="mt-2" :options="driveOptions" :icon="HardDrive" :label="t('search.drive')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-13 font-semibold leading-none">{{ t('search.modified') }}</h3>
              <Select v-model="modifiedPreset" class="mt-2" :options="modifiedOptions" :icon="Calendar" :label="t('search.modified')" />
              <!-- The window the listing chips carry: a date, which of the two dates it reads, and how wide it is.
                   Empty box = no window, and the presets above are back in charge. -->
              <p class="mt-2 text-11.5 leading-none text-text-3">{{ t('search.dateWindow') }}</p>
              <div class="mt-1.5 flex items-center gap-2">
                <Input v-model="aroundDate" type="date" :height="34" :width="150" :label="t('search.dateWindowDate')" />
                <Select v-model="aroundSpan" :options="aroundSpanOptions" dense :label="t('search.dateWindowSpan')" />
              </div>
              <Select v-if="query.around" v-model="aroundField" class="mt-2" :options="aroundFieldOptions" dense :label="t('search.dateWindowField')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-13 font-semibold leading-none">{{ t('search.fileType') }}</h3>
              <Select v-model="query.fileType" class="mt-2" :options="typeOptions" :icon="File" :label="t('search.fileType')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-13 font-semibold leading-none">{{ t('search.tags') }}</h3>
              <Input v-model="tagDraft" class="mt-2" :placeholder="t('search.tagsPlaceholder')" :label="t('search.tags')" @enter="addTag" />
              <ul v-if="query.tags.length" class="mt-2 flex flex-wrap gap-2">
                <li
                  v-for="tag in query.tags"
                  :key="tag"
                  class="flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-3 pr-2 text-11.5 leading-none text-primary"
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
              <h3 class="flex h-5 items-center text-13 font-semibold leading-none">{{ t('search.owner') }}</h3>
              <Select v-model="owner" class="mt-2" :options="ownerOptions" :icon="User" :label="t('search.owner')" />
            </section>
            <section>
              <h3 class="flex h-5 items-center text-13 font-semibold leading-none">{{ t('search.sizeRange') }}</h3>
              <div class="mt-2 flex items-center gap-1.5">
                <Select v-model="query.size.preset" :options="sizeOptions" :width="94" dense :label="t('search.sizeRange')" />
                <Input v-model="sizeMin" type="number" :width="64" :placeholder="t('search.min')" :label="t('search.min')" @enter="submit" />
                <span class="text-13 leading-none text-text-3">–</span>
                <Input v-model="sizeMax" type="number" :width="64" :placeholder="t('search.max')" :label="t('search.max')" @enter="submit" />
                <Select v-model="query.size.unit" :options="unitOptions" :width="62" dense :label="t('search.unit')" />
              </div>
            </section>
            <section>
              <h3 class="flex h-5 items-center gap-1.5 text-13 font-semibold leading-none">
                {{ t('search.path') }}
                <HelpCircle :size="14" class="text-text-3" :aria-label="t('search.pathHelp')" role="img">
                  <title>{{ t('search.pathHelp') }}</title>
                </HelpCircle>
              </h3>
              <Segmented v-model="query.pathMode" class="mt-2" :options="pathModeOptions" :label="t('search.pathMode')" />
              <!-- Completed against the paths this browser has searched with before, not against the folders that
                   exist: what a person retypes is what they typed last time, and a tree they have never opened is
                   a longer list that answers a different question. -->
              <Input
                v-model="query.path"
                class="mt-2"
                :placeholder="t('search.pathHint')"
                :label="t('search.path')"
                :suggestions="store.history.paths"
                @blur="checkPath"
                @enter="submit"
              />
              <p class="mt-1 text-11 leading-none" :class="pathProblem ? 'text-danger' : 'text-text-3'" aria-live="polite">
                {{ pathProblem || pathHint }}
              </p>
            </section>
            <section>
              <h3 class="flex h-5 items-center gap-2 text-13 font-semibold leading-none">
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
          <h3 class="text-13 font-semibold leading-none" aria-live="polite">{{ t(store.capped ? 'search.matchingMore' : 'search.matching', store.total) }}</h3>
          <button type="button" class="text-11.5 leading-none text-primary hover:underline" @click="submit">{{ t('search.viewAll') }}</button>
        </div>

        <ul class="mt-2" :aria-busy="store.loading">
          <li v-for="hit in liveHits" :key="hit.node.id" class="flex h-9 items-center leading-none">
            <span class="flex w-6 shrink-0 justify-center"><HitIcon :node="hit.node" :size="24" /></span>
            <span class="ml-[26px] min-w-[72px] truncate text-13 font-medium">{{ hit.node.name }}</span>
            <span class="ml-2 shrink-0 text-11 text-text-3">{{ hitFolderLabel(hit, files.storages) }}</span>
            <span class="min-w-0 flex-1 truncate px-4 text-center text-11 text-text-3">
              <Snippet v-if="hit.snippet" :text="hit.snippet.text" :ranges="hit.snippet.ranges" />
            </span>
            <span class="shrink-0 text-11 text-text-3">
              {{ hit.node.kind === 'folder' ? t('search.updated', { date: formatDate(hit.node.modifiedAt) }) : formatDate(hit.node.modifiedAt) }}
            </span>
            <span class="ml-4 w-14 shrink-0 text-right text-11">
              {{ hit.node.kind === 'folder' ? (hit.node.itemCount === undefined ? t('type.folder') : t('files.items', hit.node.itemCount)) : formatSize(hit.node.size) }}
            </span>
          </li>
          <li v-if="store.failed" class="flex h-9 items-center text-13 text-danger" role="alert">{{ t('search.failed') }}</li>
          <li v-else-if="!liveHits.length && !store.loading" class="flex h-9 items-center text-13 text-text-3">{{ t('search.noResults') }}</li>
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
