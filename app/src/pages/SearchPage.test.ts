import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { repository } from '@/data';
import { noQuota, type Node, type SearchHit, type Storage } from '@/data/types';
import { useSearchStore } from '@/features/search/searchStore';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import SearchPage from './SearchPage.vue';

const drives: Storage[] = [
  { id: 'demo', serverId: 4, name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] },
  { id: 'work', serverId: 9, name: 'work', rootId: 'work://', quota: noQuota(), shared: false, viaGroups: [] },
  // A drive from a server too old to send row ids: it cannot narrow anything, so it must not be offered as if it could.
  { id: 'legacy', serverId: 0, name: 'legacy', rootId: 'legacy://', quota: noQuota(), shared: false, viaGroups: [] },
];

const node = (name: string): Node => ({ id: `demo://Design/${name}`, name, kind: 'file', parentId: 'demo://Design', size: 1, ownerId: 'u1', shared: false, starred: false });
const hit = (name: string, folderPath = 'Design'): SearchHit => ({ node: node(name), storageId: 'demo', folderPath });

describe('Search results page', () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/search', name: 'search', component: { template: '<div />' } },
      { path: '/files/:path*', name: 'files', component: { template: '<div />' } },
    ],
  });
  let cleanup: (() => void) | undefined;

  beforeEach(async () => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'listStorages').mockResolvedValue(drives);
    vi.spyOn(repository, 'currentUser').mockResolvedValue({ id: 'u1', name: 'Me', initial: 'M', email: 'me@filex.test', role: 'member' });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'search').mockResolvedValue({ hits: [hit('a.md'), hit('b.md')], total: 2, capped: false });
    await useFilesStore().bootstrap();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  async function open(url = '/search?q=report') {
    await router.push(url);
    const wrapper = mount(SearchPage, { attachTo: document.body, global: { plugins: [router, i18n] } });
    cleanup = () => wrapper.unmount();
    await flushPromises();
    return wrapper;
  }

  it('skips the folder a row sits in, and puts it back', async () => {
    const wrapper = await open();
    const skip = wrapper.find('[aria-label="Skip /demo/Design"]');
    expect(skip.exists()).toBe(true);

    await skip.trigger('click');
    await flushPromises();
    // Through the URL, like every other change to this query — the page runs what the address says.
    expect(router.currentRoute.value.query.skip).toEqual(['Design']);
    expect(useSearchStore().query.excludePaths).toEqual(['Design']);
    // The chip is the only record of what was removed: nothing counts it, so it has to name it.
    expect(wrapper.text()).toContain('Except /Design');

    await wrapper.find('[aria-label="Stop skipping /Design"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.skip).toBeUndefined();
    expect(useSearchStore().query.excludePaths).toEqual([]);
  });

  it('offers no skip on a row sitting at a drive’s root, where there is no folder to leave out', async () => {
    vi.spyOn(repository, 'search').mockResolvedValue({ hits: [hit('root.md', '')], total: 1, capped: false });
    const wrapper = await open();
    expect(wrapper.find('[aria-label^="Skip "]').exists()).toBe(false);
  });

  it('counts what was FOUND, and says so as a floor when the answer was cut off', async () => {
    vi.spyOn(repository, 'search').mockResolvedValue({ hits: [hit('a.md')], total: 100, capped: true });
    const wrapper = await open();
    // "100+", never "100": the answer stopped at the limit, so the number is a floor. And never a second half
    // about what an exclusion removed — the engine does not return those rows to be counted.
    expect(wrapper.text()).toContain('100+');
  });

  it('narrows to one drive, and offers no narrowing by a drive whose id the server did not send', async () => {
    const wrapper = await open();
    const select = wrapper.find('select');
    expect(select.findAll('option').map((o) => o.text())).toEqual(['All drives', 'demo', 'work', 'legacy']);
    expect(select.findAll('option')[3].attributes('disabled')).toBeDefined();

    await select.setValue('work');
    await flushPromises();
    expect(router.currentRoute.value.query.drive).toBe('work');
    expect(useSearchStore().query.drive).toBe('work');
  });

  it('widens a current-folder scope to the whole drive when a drive is picked', async () => {
    const wrapper = await open('/search?q=report&in=current&folder=Design');
    await wrapper.find('select').setValue('work');
    await flushPromises();
    // Two controls describing different places at once is the contradiction the Path box was taught not to have.
    expect(useSearchStore().query.searchIn).toBe('all');
    expect(router.currentRoute.value.query.folder).toBeUndefined();
  });
});
