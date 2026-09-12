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

  it('restores the assistant panel but never the details panel, including legacy payloads', async () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'list', rightPanel: 'assistant', detailsOpen: false, assistantOpen: true }));
    const view = useViewStore();
    expect([view.mode, view.detailsOpen, view.assistantOpen]).toEqual(['list', true, true]);
    view.togglePanel('assistant');
    view.togglePanel('details');
    view.toggleSortDir();
    await nextTick();
    expect(JSON.parse(backing.get(KEY) ?? '{}')).toEqual({
      mode: 'list',
      sortKey: 'modified',
      sortDir: 'asc',
      sidebarCollapsed: false,
      sidebarWidth: 192,
      assistantWidth: 432,
      detailsWidth: 256,
      assistantOpen: false,
    });
  });

  it('keeps the assistant closed when the stored flag is not a boolean', () => {
    localStorage.setItem(KEY, JSON.stringify({ assistantOpen: 'yes' }));
    expect(useViewStore().assistantOpen).toBe(false);
  });

  it('ignores non-object payloads', () => {
    localStorage.setItem(KEY, JSON.stringify(['list']));
    expect(useViewStore().mode).toBe('grid');
    setActivePinia(createPinia());
    localStorage.setItem(KEY, 'null');
    expect(useViewStore().mode).toBe('grid');
  });

  it('restores a valid payload', () => {
    localStorage.setItem(KEY, JSON.stringify({ mode: 'list', sortKey: 'name', sortDir: 'asc', sidebarCollapsed: true }));
    const view = useViewStore();
    expect([view.mode, view.sortKey, view.sortDir, view.sidebarCollapsed]).toEqual(['list', 'name', 'asc', true]);
  });

  it('keeps the sidebar expanded when the stored flag is not a boolean', () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarCollapsed: 'yes' }));
    expect(useViewStore().sidebarCollapsed).toBe(false);
  });

  it('clamps the assistant width on load and on set, and persists it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ assistantWidth: 9000 }));
    expect(useViewStore().assistantWidth).toBe(720);
    setActivePinia(createPinia());
    localStorage.setItem(KEY, JSON.stringify({ assistantWidth: 'wide' }));
    const view = useViewStore();
    expect(view.assistantWidth).toBe(432);
    view.setAssistantWidth(100);
    expect(view.assistantWidth).toBe(320);
    view.setAssistantWidth(500.4);
    await nextTick();
    expect(JSON.parse(backing.get(KEY) ?? '{}').assistantWidth).toBe(500);
  });

  it('clamps the details width on load and on set, and persists it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ detailsWidth: 9000 }));
    expect(useViewStore().detailsWidth).toBe(720);
    setActivePinia(createPinia());
    localStorage.setItem(KEY, JSON.stringify({ detailsWidth: null }));
    const view = useViewStore();
    expect(view.detailsWidth).toBe(256);
    view.setDetailsWidth(100);
    expect(view.detailsWidth).toBe(230);
    view.setDetailsWidth(400.6);
    await nextTick();
    expect(JSON.parse(backing.get(KEY) ?? '{}').detailsWidth).toBe(401);
  });

  it('clamps the sidebar width on load and on set, and persists it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 9000 }));
    expect(useViewStore().sidebarWidth).toBe(400);
    setActivePinia(createPinia());
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 'wide' }));
    const view = useViewStore();
    expect(view.sidebarWidth).toBe(192);
    view.setSidebarWidth(100);
    expect(view.sidebarWidth).toBe(160);
    view.setSidebarWidth(250.6);
    await nextTick();
    expect(JSON.parse(backing.get(KEY) ?? '{}').sidebarWidth).toBe(251);
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
