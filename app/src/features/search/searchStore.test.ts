import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { repository } from '@/data';
import type { SearchResult } from '@/data/types';
import { emptyQuery, fromUrlQuery, hitFolderLabel, toUrlQuery, useSearchStore } from './searchStore';

describe('search URL mapping', () => {
  it('writes nothing for the neutral query', () => {
    expect(toUrlQuery(emptyQuery())).toEqual({});
  });

  it('round-trips every field', () => {
    const query = {
      ...emptyQuery(),
      text: 'design brief',
      scope: 'content' as const,
      searchIn: 'shared' as const,
      folderPath: 'Design/Assets',
      modified: 'week' as const,
      fileType: 'images' as const,
      tags: ['design', 'project alpha'],
      ownerId: 'demo',
      size: { preset: 'custom' as const, min: 1.5, max: 20, unit: 'GB' as const },
      path: '/demo/design/',
      wholePhrase: true,
    };
    const url = toUrlQuery(query);
    // Tags are repeated params, so a tag may contain a comma.
    expect(url.tags).toEqual(['design', 'project alpha']);
    // `folder` only matters for the current-folder scope.
    expect(url).not.toHaveProperty('folder');
    expect(fromUrlQuery(url)).toEqual({ ...query, folderPath: '' });

    const current = { ...query, searchIn: 'current' as const };
    expect(toUrlQuery(current).folder).toBe('Design/Assets');
    expect(fromUrlQuery(toUrlQuery(current))).toEqual(current);
  });

  it('ignores unknown or malformed values', () => {
    // `case` and `ocr` are old links: the boxes they carried are gone, so they are read as no query at all.
    expect(fromUrlQuery({ q: ['a', 'b'], scope: 'bogus', min: 'x', tags: ' ', case: '1', ocr: '0', size: null })).toEqual({
      ...emptyQuery(),
      text: 'a',
    });
    expect(
      fromUrlQuery({
        q: null,
        in: 'everywhere',
        modified: '',
        type: ['images', 'bogus'],
        tags: ['a', ' a ', '', null, 'b,c'],
        owner: '',
        size: 'huge',
        min: ['5', 'x'],
        max: 'Infinity',
        unit: 'TB',
        phrase: 'true',
      }),
    ).toEqual({
      ...emptyQuery(),
      fileType: 'images',
      tags: ['a', 'b,c'],
      size: { ...emptyQuery().size, min: 5 },
    });
  });

  it('labels a hit with the storage name and its folder path', () => {
    const storages = [{ id: 'demo', name: 'Demo', rootId: 'demo', quota: { usedBytes: 0, totalBytes: 1 }, shared: false }];
    const node = { id: 'x' } as SearchResult['hits'][number]['node'];
    expect(hitFolderLabel({ node, storageId: 'demo', folderPath: '' }, storages)).toBe('/Demo');
    expect(hitFolderLabel({ node, storageId: 'demo', folderPath: 'Design/Assets' }, storages)).toBe('/Demo/Design/Assets');
    expect(hitFolderLabel({ node, storageId: 'other', folderPath: 'a' }, storages)).toBe('/other/a');
  });
});

describe('search store', () => {
  it('opens neutral, resets to neutral and runs the mock search', async () => {
    setActivePinia(createPinia());
    const store = useSearchStore();
    expect(store.query).toEqual(emptyQuery());
    store.openModal('brief');
    expect(store.open).toBe(true);
    expect(store.query.text).toBe('brief');
    store.query.tags = ['design'];
    store.reset();
    expect(store.query).toEqual(emptyQuery());

    store.query.text = 'design';
    await store.run();
    expect(store.total).toBe(store.hits.length);
    expect(store.hits.map((h) => h.node.name).slice(0, 3)).toEqual(['Design', 'overview.pdf', 'beach.png']);
    expect(store.hits).toHaveLength(14);
  });

  describe('out-of-order responses', () => {
    afterEach(() => vi.restoreAllMocks());

    it('publishes only the newest request even when an older one resolves last', async () => {
      setActivePinia(createPinia());
      const store = useSearchStore();
      const pending: ((result: SearchResult) => void)[] = [];
      vi.spyOn(repository, 'search').mockImplementation(() => new Promise((resolve) => pending.push(resolve)));

      store.query.text = 'first';
      const first = store.run();
      store.query.text = 'second';
      const second = store.run();
      expect(pending).toHaveLength(2);
      expect(store.loading).toBe(true);

      pending[1]({ hits: [], total: 2 });
      await second;
      expect(store.total).toBe(2);
      expect(store.loading).toBe(false);

      // The stale answer arrives afterwards and must be dropped without flipping `loading`.
      pending[0]({ hits: [], total: 1 });
      await first;
      expect(store.total).toBe(2);
      expect(store.loading).toBe(false);
    });

    it('resets loading when the request fails', async () => {
      setActivePinia(createPinia());
      const store = useSearchStore();
      vi.spyOn(repository, 'search').mockRejectedValue(new Error('offline'));
      await expect(store.run()).rejects.toThrow('offline');
      expect(store.loading).toBe(false);
    });
  });
});
