import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import type { LocationQuery } from 'vue-router';
import { repository } from '@/data';
import { fromWindowQuery, toWindowQuery } from '@/data/dateWindow';
import { joinPath, segments } from '@/lib/path';
import { readHistory, remember, writeHistory, type SearchHistory } from './searchHistory';
import {
  FILE_TYPE_GROUPS,
  MODIFIED_PRESETS,
  PATH_MODES,
  SEARCH_INS,
  SEARCH_SCOPES,
  SIZE_PRESETS,
  SIZE_UNITS,
  type SearchHit,
  type SearchQuery,
  type Storage,
} from '@/data/types';

/** Neutral query: nothing typed, no filters. Absent URL params mean these values. */
export function emptyQuery(): SearchQuery {
  return {
    text: '',
    scope: 'all',
    searchIn: 'current',
    drive: null,
    folderPath: '',
    modified: 'any',
    around: null,
    fileType: 'any',
    tags: [],
    ownerId: null,
    size: { preset: 'any', min: null, max: null, unit: 'MB' },
    path: '',
    pathMode: 'only',
    excludePaths: [],
    wholePhrase: false,
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function first(value: LocationQuery[string]): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single : null;
}

function all(value: LocationQuery[string]): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
}

function num(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Only values that differ from `emptyQuery()` are written, so the URL stays short and self-describing. */
export function toUrlQuery(query: SearchQuery): Record<string, string | string[]> {
  const neutral = emptyQuery();
  const out: Record<string, string | string[]> = {};
  if (query.text) out.q = query.text;
  if (query.scope !== neutral.scope) out.scope = query.scope;
  if (query.searchIn !== neutral.searchIn) out.in = query.searchIn;
  if (query.drive) out.drive = query.drive;
  if (query.searchIn === 'current' && query.folderPath) out.folder = query.folderPath;
  if (query.modified !== neutral.modified) out.modified = query.modified;
  // The same three parameters the listing writes, so a window means one thing across the app.
  Object.assign(out, toWindowQuery(query.around));
  if (query.fileType !== neutral.fileType) out.type = query.fileType;
  if (query.tags.length) out.tags = [...query.tags];
  if (query.ownerId) out.owner = query.ownerId;
  if (query.size.preset !== neutral.size.preset) out.size = query.size.preset;
  if (query.size.min !== null) out.min = String(query.size.min);
  if (query.size.max !== null) out.max = String(query.size.max);
  if (query.size.unit !== neutral.size.unit) out.unit = query.size.unit;
  if (query.path) out.path = query.path;
  // Only alongside a path: a mode on its own says nothing, and a URL that carried it would be describing a box
  // that is empty.
  if (query.path && query.pathMode !== neutral.pathMode) out.pathmode = query.pathMode;
  if (query.excludePaths.length) out.skip = [...query.excludePaths];
  if (query.wholePhrase) out.phrase = '1';
  return out;
}

export function fromUrlQuery(raw: LocationQuery): SearchQuery {
  const neutral = emptyQuery();
  return {
    text: first(raw.q) ?? '',
    scope: pick(first(raw.scope), SEARCH_SCOPES, neutral.scope),
    searchIn: pick(first(raw.in), SEARCH_INS, neutral.searchIn),
    drive: first(raw.drive) || null,
    folderPath: first(raw.folder) ?? '',
    modified: pick(first(raw.modified), MODIFIED_PRESETS, neutral.modified),
    around: fromWindowQuery(raw),
    fileType: pick(first(raw.type), FILE_TYPE_GROUPS, neutral.fileType),
    tags: [...new Set(all(raw.tags).map((t) => t.trim()).filter(Boolean))],
    ownerId: first(raw.owner) || null,
    size: {
      preset: pick(first(raw.size), SIZE_PRESETS, neutral.size.preset),
      min: num(first(raw.min)),
      max: num(first(raw.max)),
      unit: pick(first(raw.unit), SIZE_UNITS, neutral.size.unit),
    },
    path: first(raw.path) ?? '',
    pathMode: pick(first(raw.pathmode), PATH_MODES, neutral.pathMode),
    excludePaths: [...new Set(all(raw.skip).map((p) => p.trim()).filter(Boolean))],
    wholePhrase: first(raw.phrase) === '1',
  };
}

/** Display form of a hit's folder, "/demo/Design": storage name plus the path below its root. */
export function hitFolderLabel(hit: SearchHit, storages: Storage[]): string {
  const storage = storages.find((s) => s.id === hit.storageId)?.name ?? hit.storageId;
  return `/${joinPath([storage, ...segments(hit.folderPath)])}`;
}

export const useSearchStore = defineStore('search', () => {
  // Only the newest request may publish; a slower one that resolves later must not overwrite it.
  let seq = 0;
  const open = ref(false);
  const query = reactive<SearchQuery>(emptyQuery());
  const hits = ref<SearchHit[]>([]);
  const total = ref(0);
  /** The answer stopped at the limit, so `total` is a floor: the count line says "N+" rather than "N". */
  const capped = ref(false);
  const loading = ref(false);
  /**
   * The last run did not answer. `run` still rejects — a caller that awaits it must be able to tell — but nothing
   * ever caught it, so a search against an unreachable server drew "No results", which is a claim about the drive.
   */
  const failed = ref(false);
  /**
   * What this browser has searched for before — what the query and Path boxes complete against. Read once, here,
   * rather than per keystroke in the component: it is a file on disk as far as the browser is concerned.
   */
  const history = ref<SearchHistory>(readHistory());

  function assign(next: SearchQuery) {
    Object.assign(query, next, { size: { ...next.size }, tags: [...next.tags], excludePaths: [...next.excludePaths] });
  }

  function reset() {
    assign(emptyQuery());
  }

  /**
   * Drops the results without running anything: an empty query has nothing to ask the server, and the previous
   * answer must not stay on screen behind it. Bumping `seq` disowns a run still in flight, which would otherwise
   * publish its hits into the cleared page.
   */
  function clearResults() {
    seq += 1;
    hits.value = [];
    total.value = 0;
    capped.value = false;
    failed.value = false;
    loading.value = false;
  }

  /**
   * Opens the modal; `text` prefills the query field (from the topbar box) and `folderPath` the
   * current-folder scope (from the files route). Both are set before `open` flips so the modal's
   * first run sees the final form.
   */
  function openModal(text?: string, folderPath?: string) {
    if (text !== undefined) query.text = text;
    if (folderPath !== undefined) query.folderPath = folderPath;
    open.value = true;
  }

  function close() {
    open.value = false;
  }

  async function run() {
    const id = ++seq;
    // Recorded on the way OUT, not on a keystroke and not on the answer: what a person searched for is what they
    // asked, whether or not it found anything — a query that came back empty is exactly the one worth offering
    // back when they try it again differently.
    const recorded = remember(history.value, query);
    if (recorded !== history.value) {
      history.value = recorded;
      writeHistory(recorded);
    }
    loading.value = true;
    try {
      const result = await repository.search(JSON.parse(JSON.stringify(query)));
      if (id !== seq) return;
      hits.value = result.hits;
      total.value = result.total;
      capped.value = result.capped;
      failed.value = false;
    } catch (error) {
      // A newer request owns the results; its own answer decides what they say.
      if (id === seq) {
        failed.value = true;
        hits.value = [];
        total.value = 0;
        capped.value = false;
      }
      throw error;
    } finally {
      if (id === seq) loading.value = false;
    }
  }

  return { open, query, hits, total, capped, loading, failed, history, assign, reset, clearResults, openModal, close, run };
});
