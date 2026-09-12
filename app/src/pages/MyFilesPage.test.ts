import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { repository } from '@/data';
import { noQuota, type Node, type Storage } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import MyFilesPage from './MyFilesPage.vue';

const FOLDER = 'main://Docs';
const storage: Storage = { id: 'main', serverId: 1, name: 'main', rootId: 'main://', quota: noQuota(), shared: false, viaGroups: [] };
const folder: Node = { id: FOLDER, name: 'Docs', kind: 'folder', parentId: 'main://', size: 0, ownerId: 'u1', shared: false, starred: false };
const file: Node = { id: `${FOLDER}/a.png`, name: 'a.png', kind: 'file', parentId: FOLDER, size: 1, ownerId: 'u1', fileType: 'image', shared: false, starred: false };

describe('My files under a filter change', () => {
  const router = createRouter({
    history: createMemoryHistory(),
    // A placeholder, not the page itself: the page under test is mounted by hand, and a second instance behind
    // the route would run every watcher twice.
    routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }],
  });
  let resolvePath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'listStorages').mockResolvedValue([storage]);
    vi.spyOn(repository, 'currentUser').mockResolvedValue({ id: 'u1', name: 'Me', initial: 'M', email: 'me@filex.test', role: 'member' });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [file], total: 1500 });
    resolvePath = vi.spyOn(repository, 'resolvePath').mockResolvedValue(folder) as unknown as ReturnType<typeof vi.fn>;
  });
  afterEach(() => vi.restoreAllMocks());

  /**
   * Narrowing from the details panel writes the filter into the address, and a fresh `route.params` object used to
   * look like a navigation: the folder was reopened, which asks for the same rows again and clears the selection —
   * dropping the very file whose properties were being clicked.
   */
  it('keeps the selected file when a chip writes itself into the address', async () => {
    const files = useFilesStore();
    await router.push('/files/main/Docs');
    const wrapper = mount(MyFilesPage, { shallow: true, global: { plugins: [router, i18n] } });
    await files.bootstrap();
    await flushPromises();
    expect(resolvePath).toHaveBeenCalledTimes(1);

    files.select(file.id);
    await files.setFilter({ ...files.filter, fileType: 'images' });
    await flushPromises();

    expect(router.currentRoute.value.query).toEqual({ type: 'images' });
    expect(resolvePath).toHaveBeenCalledTimes(1);
    expect(files.selected.map((n) => n.id)).toEqual([file.id]);
    wrapper.unmount();
  });

  it('still reopens the folder when the address really moves', async () => {
    const files = useFilesStore();
    await router.push('/files/main/Docs');
    const wrapper = mount(MyFilesPage, { shallow: true, global: { plugins: [router, i18n] } });
    await files.bootstrap();
    await flushPromises();

    await router.push('/files/main/Other');
    await flushPromises();
    expect(resolvePath).toHaveBeenCalledTimes(2);
    expect(resolvePath).toHaveBeenLastCalledWith('main', 'Other');
    wrapper.unmount();
  });
});
