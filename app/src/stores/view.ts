import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type ViewMode = 'grid' | 'list';
export type SortKey = 'name' | 'modified' | 'size';
export type SortDir = 'asc' | 'desc';
/** The two right-hand panels open independently: details next to the listing, the assistant at the shell's edge. */
export type RightPanel = 'details' | 'assistant';

const STORAGE_KEY = 'filex.app.view';

const VIEW_MODES: ViewMode[] = ['grid', 'list'];
export const SORT_KEYS: readonly SortKey[] = ['name', 'modified', 'size'];
const SORT_DIRS: SortDir[] = ['asc', 'desc'];
/** Spec §6 draws the assistant at 432; the drag handle keeps it between a readable minimum and half a laptop screen. */
export const ASSISTANT_WIDTH = { min: 320, default: 432, max: 720 } as const;

/**
 * The details panel is session-only: a reload (or a `?panel=` screenshot link) must not restore it. The assistant
 * is a conversation the person comes back to, so its open state is remembered along with the last session it showed.
 */
interface Persisted {
  mode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  /** The sidebar's rail mode: a layout choice, so it outlives the session unlike the right panels. */
  sidebarCollapsed: boolean;
  /** Assistant panel width in px: a layout choice like the rail. */
  assistantWidth: number;
  assistantOpen: boolean;
}

const DEFAULTS: Persisted = {
  mode: 'grid',
  sortKey: 'modified',
  sortDir: 'desc',
  sidebarCollapsed: false,
  assistantWidth: ASSISTANT_WIDTH.default,
  assistantOpen: false,
};

function clampAssistantWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ASSISTANT_WIDTH.default;
  return Math.round(Math.min(ASSISTANT_WIDTH.max, Math.max(ASSISTANT_WIDTH.min, value)));
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Persisted state is untrusted: every field is checked against its allowed values. */
function load(): Persisted {
  let raw: unknown = {};
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    // unreadable or absent — start from defaults
  }
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    mode: pick(saved.mode, VIEW_MODES, DEFAULTS.mode),
    sortKey: pick(saved.sortKey, SORT_KEYS, DEFAULTS.sortKey),
    sortDir: pick(saved.sortDir, SORT_DIRS, DEFAULTS.sortDir),
    sidebarCollapsed: typeof saved.sidebarCollapsed === 'boolean' ? saved.sidebarCollapsed : DEFAULTS.sidebarCollapsed,
    assistantWidth: clampAssistantWidth(saved.assistantWidth),
    assistantOpen: typeof saved.assistantOpen === 'boolean' ? saved.assistantOpen : DEFAULTS.assistantOpen,
  };
}

export const useViewStore = defineStore('view', () => {
  const saved = load();
  const mode = ref<ViewMode>(saved.mode);
  const sortKey = ref<SortKey>(saved.sortKey);
  const sortDir = ref<SortDir>(saved.sortDir);
  const sidebarCollapsed = ref(saved.sidebarCollapsed);
  const assistantWidth = ref(saved.assistantWidth);
  const detailsOpen = ref(true);
  const assistantOpen = ref(saved.assistantOpen);

  watch([mode, sortKey, sortDir, sidebarCollapsed, assistantWidth, assistantOpen], () => {
    const data: Persisted = {
      mode: mode.value,
      sortKey: sortKey.value,
      sortDir: sortDir.value,
      sidebarCollapsed: sidebarCollapsed.value,
      assistantWidth: assistantWidth.value,
      assistantOpen: assistantOpen.value,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // storage unavailable — view state simply is not remembered
    }
  });

  function toggleSortDir() {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  }

  /** Shared by the table header and the sort pill: a new key starts ascending, the current key flips direction. */
  function setSortKey(key: SortKey) {
    if (sortKey.value === key) toggleSortDir();
    else {
      sortKey.value = key;
      sortDir.value = 'asc';
    }
  }

  /** The drag handle reports raw pointer math; the limits live here so the stored value is always sane. */
  function setAssistantWidth(px: number) {
    assistantWidth.value = clampAssistantWidth(px);
  }

  function togglePanel(panel: RightPanel) {
    const target = panel === 'details' ? detailsOpen : assistantOpen;
    target.value = !target.value;
  }

  return {
    mode,
    sortKey,
    sortDir,
    sidebarCollapsed,
    assistantWidth,
    detailsOpen,
    assistantOpen,
    toggleSortDir,
    setSortKey,
    setAssistantWidth,
    togglePanel,
  };
});
