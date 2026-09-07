import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { AssistantMode } from '@/data/types';

/** "system" leaves `data-theme` off so tokens.css follows `prefers-color-scheme`. */
export type Theme = 'light' | 'system' | 'dark';
export type ConflictBehavior = 'ask' | 'replace' | 'keepBoth' | 'skip';

const STORAGE_KEY = 'filex.app.settings';

export const THEMES: readonly Theme[] = ['light', 'system', 'dark'];
export const CONFLICT_BEHAVIORS: readonly ConflictBehavior[] = ['ask', 'replace', 'keepBoth', 'skip'];
export const ASSISTANT_MODE_VALUES: readonly AssistantMode[] = ['filename', 'content', 'tags'];
/** Short curated list; the browser's own zone is added on top of it by the modal. */
export const TIME_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/**
 * Everything the user settings modal writes. Profile fields and the notification switches are local mocks until the
 * backend grows the endpoints (docs/BACKEND-GAP.md); theme, language and the compact list take effect immediately.
 */
export interface Settings {
  theme: Theme;
  compactList: boolean;
  timeZone: string;
  /** Node id of the folder uploads land in; "" is the storage root. */
  defaultUploadFolder: string;
  autoOpenPreview: boolean;
  conflictBehavior: ConflictBehavior;
  fullName: string;
  displayName: string;
  jobTitle: string;
  notifyShared: boolean;
  notifyComments: boolean;
  notifyUploads: boolean;
  assistantEnabled: boolean;
  assistantMode: AssistantMode;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultSettings(): Settings {
  return {
    theme: 'system',
    compactList: false,
    timeZone: browserZone(),
    defaultUploadFolder: '',
    autoOpenPreview: true,
    conflictBehavior: 'ask',
    fullName: '',
    displayName: '',
    jobTitle: '',
    notifyShared: true,
    notifyComments: true,
    notifyUploads: false,
    assistantEnabled: true,
    assistantMode: 'filename',
  };
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Persisted state is untrusted: every field is checked against its allowed values, as in the view store. */
function load(): Settings {
  const base = defaultSettings();
  let raw: unknown = {};
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return base;
  }
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    theme: pick(saved.theme, THEMES, base.theme),
    compactList: bool(saved.compactList, base.compactList),
    timeZone: text(saved.timeZone, base.timeZone),
    defaultUploadFolder: text(saved.defaultUploadFolder, base.defaultUploadFolder),
    autoOpenPreview: bool(saved.autoOpenPreview, base.autoOpenPreview),
    conflictBehavior: pick(saved.conflictBehavior, CONFLICT_BEHAVIORS, base.conflictBehavior),
    fullName: text(saved.fullName, base.fullName),
    displayName: text(saved.displayName, base.displayName),
    jobTitle: text(saved.jobTitle, base.jobTitle),
    notifyShared: bool(saved.notifyShared, base.notifyShared),
    notifyComments: bool(saved.notifyComments, base.notifyComments),
    notifyUploads: bool(saved.notifyUploads, base.notifyUploads),
    assistantEnabled: bool(saved.assistantEnabled, base.assistantEnabled),
    assistantMode: pick(saved.assistantMode, ASSISTANT_MODE_VALUES, base.assistantMode),
  };
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(load());
  const open = ref(false);

  // The attribute is absent for "system", which is what tokens.css treats as "follow the OS".
  watch(
    () => settings.value.theme,
    (theme) => {
      if (theme === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
    },
    { immediate: true },
  );

  watch(
    settings,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // storage unavailable — settings simply are not remembered
      }
    },
    { deep: true },
  );

  /** The modal edits a copy and commits it here, so Cancel needs no undo. */
  function apply(next: Settings) {
    settings.value = next;
  }

  return { settings, open, apply };
});
