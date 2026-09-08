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
    localStorage.setItem(KEY, JSON.stringify({ theme: 'sepia', conflictBehavior: 'replace', compactList: 'yes', defaultUploadFolder: 7 }));
    const { settings } = useSettingsStore();
    expect(settings.theme).toBe('system');
    expect(settings.conflictBehavior).toBe('replace');
    expect(settings.compactList).toBe(false);
    expect(settings.defaultUploadFolder).toBe('');
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
    store.apply({ ...store.settings, theme: 'light', compactList: true, defaultUploadFolder: 'demo://Design' });
    await nextTick();
    const saved = JSON.parse(backing.get(KEY) ?? '{}');
    expect(saved).toMatchObject({ theme: 'light', compactList: true, defaultUploadFolder: 'demo://Design' });

    setActivePinia(createPinia());
    expect(useSettingsStore().settings.defaultUploadFolder).toBe('demo://Design');
  });
});
