import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, useSettingsStore } from './settingsStore';

const KEY = 'filex.app.settings';

// happy-dom exposes no localStorage here; the store only needs getItem/setItem.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
});

describe('settings store', () => {
  beforeEach(() => {
    backing.clear();
    delete document.documentElement.dataset.theme;
    setActivePinia(createPinia());
  });

  it('falls back to defaults on unparsable storage', () => {
    localStorage.setItem(KEY, '{not json');
    expect(useSettingsStore().settings).toEqual(defaultSettings());
  });

  it('rejects values outside the allowed sets, field by field', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ theme: 'sepia', assistantMode: 'tags', compactList: 'yes', timeZone: 7, conflictBehavior: 'overwrite', defaultUploadFolder: 7, assistantEnabled: 'no' }),
    );
    const { settings } = useSettingsStore();
    expect(settings.theme).toBe('system');
    expect(settings.assistantMode).toBe('tags');
    expect(settings.compactList).toBe(false);
    expect(settings.timeZone).toBe(defaultSettings().timeZone);
    expect(settings.conflictBehavior).toBe('ask');
    expect(settings.defaultUploadFolder).toBe('');
    expect(settings.assistantEnabled).toBe(true);
  });

  // A record written by another build is read field by field: one it wrote that this build has no idea about is
  // dropped, and a field it never wrote takes its default. Neither costs the rest of the record anything — a person
  // who had picked a theme keeps it rather than being reset by their own history.
  it('reads a record written by another build, field by field', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        theme: 'dark',
        compactList: true,
        timeZone: 'Europe/Berlin',
        assistantMode: 'content',
        defaultUploadFolder: 'demo://Design',
        autoOpenPreview: false,
        conflictBehavior: 'replace',
        assistantEnabled: false,
        soundOnUpload: true,
      }),
    );
    const store = useSettingsStore();
    expect(store.settings).toEqual({
      theme: 'dark',
      compactList: true,
      timeZone: 'Europe/Berlin',
      defaultUploadFolder: 'demo://Design',
      autoOpenPreview: false,
      conflictBehavior: 'replace',
      assistantEnabled: false,
      assistantMode: 'content',
    });

    // And the next write drops the field nothing here knows about rather than carrying it along for ever.
    store.apply({ ...store.settings });
    await nextTick();
    expect(Object.keys(JSON.parse(backing.get(KEY) ?? '{}'))).not.toContain('soundOnUpload');
  });

  // Written by a build that had no upload settings at all: every one of them takes its default.
  it('falls back to the defaults for fields an older record never held', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'dark' }));
    const { settings } = useSettingsStore();
    const base = defaultSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.defaultUploadFolder).toBe(base.defaultUploadFolder);
    expect(settings.autoOpenPreview).toBe(base.autoOpenPreview);
    expect(settings.conflictBehavior).toBe('ask');
    expect(settings.assistantEnabled).toBe(true);
  });

  it('ignores non-object payloads', () => {
    localStorage.setItem(KEY, JSON.stringify(['dark']));
    expect(useSettingsStore().settings.theme).toBe('system');
  });

  it('stamps data-theme for explicit themes only', async () => {
    const store = useSettingsStore();
    expect(document.documentElement.dataset.theme).toBeUndefined();

    store.apply({ ...store.settings, theme: 'dark' });
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe('dark');

    store.apply({ ...store.settings, theme: 'system' });
    await nextTick();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('persists what apply commits', async () => {
    const store = useSettingsStore();
    store.apply({ ...store.settings, theme: 'light', compactList: true, assistantMode: 'tags' });
    await nextTick();
    const saved = JSON.parse(backing.get(KEY) ?? '{}');
    expect(saved).toMatchObject({ theme: 'light', compactList: true, assistantMode: 'tags' });

    setActivePinia(createPinia());
    expect(useSettingsStore().settings.assistantMode).toBe('tags');
  });
});
