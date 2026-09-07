import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewStore } from './view';

const KEY = 'filex.app.view';

// happy-dom exposes no localStorage here; the store only needs getItem/setItem.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
});

describe('view store persistence', () => {
  beforeEach(() => {
    backing.clear();
    setActivePinia(createPinia());
  });

  it('falls back to defaults on unparsable storage', () => {
    localStorage.setItem(KEY, '{not json');
    const view = useViewStore();
    expect([view.mode, view.sortKey, view.sortDir, view.detailsOpen, view.assistantOpen]).toEqual(['grid', 'modified', 'desc', true, false]);
  });

  it('rejects values outside the allowed sets, field by field', () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'table', sortKey: 'size', sortDir: 'up' }));
    const view = useViewStore();
    expect([view.mode, view.sortKey, view.sortDir, view.detailsOpen, view.assistantOpen]).toEqual(['grid', 'size', 'desc', true, false]);
  });

  it('never restores or writes the right panels, including legacy payloads', async () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'list', rightPanel: 'assistant', detailsOpen: false, assistantOpen: true }));
    const view = useViewStore();
    expect([view.mode, view.detailsOpen, view.assistantOpen]).toEqual(['list', true, false]);
    view.togglePanel('assistant');
    view.toggleSortDir();
    await nextTick();
    expect(JSON.parse(backing.get(KEY) ?? '{}')).toEqual({ mode: 'list', sortKey: 'modified', sortDir: 'asc' });
  });

  it('ignores non-object payloads', () => {
    localStorage.setItem(KEY, JSON.stringify(['list']));
    expect(useViewStore().mode).toBe('grid');
    setActivePinia(createPinia());
    localStorage.setItem(KEY, 'null');
    expect(useViewStore().mode).toBe('grid');
  });

  it('restores a valid payload', () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'list', sortKey: 'name', sortDir: 'asc' }));
    const view = useViewStore();
    expect([view.mode, view.sortKey, view.sortDir]).toEqual(['list', 'name', 'asc']);
  });

  it('toggles the two right panels independently', () => {
    const view = useViewStore();
    expect([view.detailsOpen, view.assistantOpen]).toEqual([true, false]);
    view.togglePanel('assistant');
    expect([view.detailsOpen, view.assistantOpen]).toEqual([true, true]);
    view.togglePanel('details');
    expect([view.detailsOpen, view.assistantOpen]).toEqual([false, true]);
    view.togglePanel('details');
    expect([view.detailsOpen, view.assistantOpen]).toEqual([true, true]);
    view.togglePanel('assistant');
    expect([view.detailsOpen, view.assistantOpen]).toEqual([true, false]);
  });
});
