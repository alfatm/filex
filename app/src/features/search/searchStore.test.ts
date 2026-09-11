import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { repository } from '@/data';
import { noQuota, type SearchHit, type SearchResult } from '@/data/types';
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

  it('round-trips the folders left out, and the direction the Path box reads', () => {
    const query = { ...emptyQuery(), text: 'config', path: '/demo/archive/', pathMode: 'skip' as const, excludePaths: ['Design/Old', 'tmp'] };
    const url = toUrlQuery(query);
    // Repeated params, like tags: a folder name may contain anything a folder name may contain.
    expect(url.skip).toEqual(['Design/Old', 'tmp']);
    expect(url.pathmode).toBe('skip');
    expect(fromUrlQuery(url)).toEqual(query);

    // The drive rides in the URL by NAME, so a shared link survives a re-import that renumbered the rows.
    expect(toUrlQuery({ ...emptyQuery(), drive: 'demo' }).drive).toBe('demo');
    expect(fromUrlQuery({ drive: 'demo' }).drive).toBe('demo');
    // "All drives" is the neutral value and writes nothing.
    expect(toUrlQuery({ ...emptyQuery(), drive: null })).not.toHaveProperty('drive');
    expect(fromUrlQuery({}).drive).toBeNull();

    // The mode is written only beside a path: on its own it describes an empty box.
    expect(toUrlQuery({ ...emptyQuery(), pathMode: 'skip' })).not.toHaveProperty('pathmode');
    // …and a link that carries a path without one still means what it always meant.
    expect(fromUrlQuery({ path: '/demo/design/' }).pathMode).toBe('only');
    // The same folder twice is one exclusion; it removes what it removes.
    expect(fromUrlQuery({ skip: ['tmp', 'tmp'] }).excludePaths).toEqual(['tmp']);
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
    const storages = [{ id: 'demo', serverId: 1, name: 'Demo', rootId: 'demo', quota: { ...noQuota(), totalBytes: 1 }, shared: false, viaGroups: [] }];
    const node = { id: 'x' } as SearchResult['hits'][number]['node'];
    expect(hitFolderLabel({ node, storageId: 'demo', folderPath: '' }, storages)).toBe('/Demo');
    expect(hitFolderLabel({ node, storageId: 'demo', folderPath: 'Design/Assets' }, storages)).toBe('/Demo/Design/Assets');
    expect(hitFolderLabel({ node, storageId: 'other', folderPath: 'a' }, storages)).toBe('/other/a');
  });
});

describe('search store', () => {
  it('records what was searched for, so the boxes can offer it back', async () => {
    setActivePinia(createPinia());
    const store = useSearchStore();
    vi.spyOn(repository, 'search').mockResolvedValue({ hits: [], total: 0, capped: false });

    store.query.text = 'rapor';
    store.query.path = '/demo/design/';
    await store.run();
    expect(store.history).toEqual({ queries: ['rapor'], paths: ['/demo/design/'] });

    // A search that found nothing is exactly the one worth offering back when it is tried again differently.
    store.query.text = 'plan';
    await store.run();
    expect(store.history.queries).toEqual(['plan', 'rapor']);
  });


  it('opens neutral, resets to neutral and publishes what the repository answers', async () => {
    setActivePinia(createPinia());
    const store = useSearchStore();
    expect(store.query).toEqual(emptyQuery());
    store.openModal('brief');
    expect(store.open).toBe(true);
    expect(store.query.text).toBe('brief');
    store.query.tags = ['design'];
    store.reset();
    expect(store.query).toEqual(emptyQuery());

    const hits = [{ node: { id: 'a', name: 'Design' } }, { node: { id: 'b', name: 'overview.pdf' } }] as SearchHit[];
    const spy = vi.spyOn(repository, 'search').mockResolvedValue({ hits, total: 2, capped: false });
    store.query.text = 'design';
    await store.run();
    // The query travels as a plain copy of the form, not the reactive object.
    expect(spy).toHaveBeenCalledWith({ ...emptyQuery(), text: 'design' });
    expect(store.hits.map((h) => h.node.name)).toEqual(['Design', 'overview.pdf']);
    expect(store.total).toBe(2);
    expect(store.capped).toBe(false);
    vi.restoreAllMocks();
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

      pending[1]({ hits: [], total: 2, capped: false });
      await second;
      expect(store.total).toBe(2);
      expect(store.loading).toBe(false);

      // The stale answer arrives afterwards and must be dropped without flipping `loading`.
      pending[0]({ hits: [], total: 1, capped: false });
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

    // Nothing caught that rejection, so the results page drew "No results" — a claim about the drive — for a
    // server that had not answered at all.
    it('records the failure and keeps no stale results', async () => {
      setActivePinia(createPinia());
      const store = useSearchStore();
      const spy = vi.spyOn(repository, 'search').mockResolvedValue({ hits: [{ node: { id: 'a' } } as SearchHit], total: 1, capped: false });
      await store.run();
      expect(store.failed).toBe(false);

      spy.mockRejectedValue(new Error('offline'));
      await expect(store.run()).rejects.toThrow('offline');
      expect(store.failed).toBe(true);
      expect(store.hits).toEqual([]);
      expect(store.total).toBe(0);

      spy.mockResolvedValue({ hits: [], total: 0, capped: false });
      await store.run();
      expect(store.failed).toBe(false);
    });
  });
});
