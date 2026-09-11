import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { AssistantMode } from '@/data/types';

/** "system" leaves `data-theme` off so tokens.css follows `prefers-color-scheme`. */
export type Theme = 'light' | 'system' | 'dark';
/**
 * What an upload does when the target folder already holds that name.
 *
 * `replace` is the only one the SERVER has an opinion about: a staged upload committed over an existing file
 * overwrites it and keeps the old bytes as a version (upload_staged.go, `writehook.BeforeOverwrite`). The other
 * three are decided here, before any bytes are sent — `keepBoth` renames to a free name the way a paste does
 * (`<base>-copy<ext>`, `-copy-2`, … — ops.uniqueCopyDest), `skip` never begins the transfer, and `ask` puts the
 * question in the upload tray, beside the row it is about.
 */
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
 * What the settings modal keeps in THIS BROWSER. The profile fields and the notification switches are not here:
 * they belong to the account and go to the server, so they follow the person to another machine. What is left is
 * genuinely local — how this browser draws and behaves — and takes effect the moment it is applied.
 */
export interface Settings {
  theme: Theme;
  compactList: boolean;
  timeZone: string;
  /**
   * Node id of the folder uploads land in when nothing else names one; "" is the drive root.
   *
   * ⚠ A node id in filex IS its path, so this goes stale the moment the folder is renamed or moved. The upload
   * store therefore treats it as a hint: it checks the folder is still there and falls back to the drive root,
   * saying so, rather than failing the upload.
   */
  defaultUploadFolder: string;
  autoOpenPreview: boolean;
  conflictBehavior: ConflictBehavior;
  /** This browser's own switch for the assistant panel; the server's is the administrator's (see BACKEND-GAP.md). */
  assistantEnabled: boolean;
  /** The search mode a new conversation starts in; the panel's chips change it for that conversation only. */
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
    autoOpenPreview: false,
    conflictBehavior: 'ask',
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

/**
 * Persisted state is untrusted: every field is checked against its allowed values, as in the view store. A record
 * written by an older build is read field by field, so one this build no longer has — or one it gained — costs the
 * rest of the record nothing.
 */
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
