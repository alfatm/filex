import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { emptyFilter } from './filters';
import { useFilterQuery } from './useFilterQuery';

const FOLDER = 'main://Docs';
const folder: Node = { id: FOLDER, name: 'Docs', kind: 'folder', parentId: 'main://', size: 0, ownerId: 'u1', shared: false, starred: false };
const file = (name: string): Node => ({ id: `${FOLDER}/${name}`, name, kind: 'file', parentId: FOLDER, size: 1, ownerId: 'u1', shared: false, starred: false, fileType: 'image' });

/** Stands in for a listing page: all it does is keep its chips and its address in step. */
const Host = defineComponent({
  setup() {
    useFilterQuery();
    return () => h('div');
  },
});

describe('the filter chips as part of the listing’s address', () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }],
  });
  let list: MockInstance<typeof repository.listFolder>;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    list = vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [file('a.png')], total: 1500 });
  });
  afterEach(() => vi.restoreAllMocks());

  async function open(query = '') {
    await router.replace(`/files/main/Docs${query}`);
    const wrapper = mount(Host, { global: { plugins: [router] } });
    return wrapper;
  }

  it('is read before the listing opens, so the first request is the filtered one', async () => {
    await open('?type=images&tags=design');
    const files = useFilesStore();
    expect(files.filter).toMatchObject({ fileType: 'images', tags: ['design'] });

    await files.open(FOLDER);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenLastCalledWith(FOLDER, expect.objectContaining({ fileType: 'images', tags: ['design'] }));
  });

  it('writes a chip back into the address without pushing a history entry per click', async () => {
    await open();
    const files = useFilesStore();
    const replace = vi.spyOn(router, 'replace');
    const push = vi.spyOn(router, 'push');

    await files.setFilter({ ...emptyFilter(), fileType: 'images', around: { field: 'modified', at: '2026-09-09T12:00:00Z', span: 'day' } });
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ type: 'images', date: 'modified', at: '2026-09-09T12:00:00Z', span: 'day' });
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('re-filters the listing when the address changes under it — Back takes the chips off', async () => {
    await open('?type=images');
    const files = useFilesStore();
    await files.open(FOLDER);
    list.mockClear();

    await router.replace('/files/main/Docs');
    await flushPromises();
    expect(files.filter).toEqual(emptyFilter());
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenLastCalledWith(FOLDER, emptyFilter());
  });

  it('drops the filter on the way to another folder, and leaves that listing’s load to the page', async () => {
    await open('?type=images');
    const files = useFilesStore();
    await files.open(FOLDER);
    list.mockClear();

    await router.push('/files/main/Other');
    await flushPromises();
    expect(files.filter).toEqual(emptyFilter());
    // The page's own route watcher opens the new folder; the filter did not ask for a listing of its own.
    expect(list).not.toHaveBeenCalled();
  });
});
