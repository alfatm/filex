import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { repository } from '@/data';
import { noCapabilities, type Node, type User } from '@/data/types';
import { i18n } from '@/i18n';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import DetailsPanel from './DetailsPanel.vue';

const FOLDER = 'demo://Docs';
const folder: Node = { id: FOLDER, name: 'Docs', kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'u1', shared: false, starred: false };
const file: Node = {
  id: `${FOLDER}/a.pdf`,
  name: 'a.pdf',
  kind: 'file',
  parentId: FOLDER,
  size: 50 * 1024 * 1024,
  ownerId: 'u7',
  fileType: 'pdf',
  modifiedAt: '2026-09-09T12:00:00Z',
  createdAt: '2026-08-01T09:00:00Z',
  shared: false,
  starred: false,
};
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }],
});

/** The rows of the General list, by the label in their `dt`. */
function row(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper.findAll('dl > div').find((entry) => entry.find('dt').text() === label);
  if (!found) throw new Error(`no ${label} row`);
  return found;
}

describe('the details panel as a way into the filter', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [file], total: 1500 });
    vi.spyOn(repository, 'shareLink').mockResolvedValue(null);
    vi.spyOn(repository, 'listTags').mockResolvedValue(['design', 'q3']);
    useCapabilitiesStore().can = { ...noCapabilities(), tags: true };
    await useFilesStore().open(FOLDER);
  });
  afterEach(() => vi.restoreAllMocks());

  async function panel() {
    const wrapper = mount(DetailsPanel, {
      props: { node: file, path: [folder], people: [], user: null },
      global: { plugins: [i18n, router] },
    });
    await flushPromises();
    return wrapper;
  }

  it('narrows by the size band and the type group the row falls in', async () => {
    const wrapper = await panel();
    const files = useFilesStore();

    await row(wrapper, 'Size').find('button').trigger('click');
    expect(files.filter.size).toBe('medium');

    await row(wrapper, 'Type').find('button').trigger('click');
    // Merged, not replaced: two clicks are two conditions.
    expect(files.filter).toMatchObject({ size: 'medium', fileType: 'documents' });
  });

  it('turns a date into a window around it, on the column the row shows', async () => {
    const wrapper = await panel();
    const files = useFilesStore();

    await row(wrapper, 'Modified').find('button').trigger('click');
    expect(files.filter.around).toEqual({ field: 'modified', at: file.modifiedAt, span: 'day' });

    await row(wrapper, 'Created').find('button').trigger('click');
    expect(files.filter.around).toEqual({ field: 'created', at: file.createdAt, span: 'day' });
  });

  it('lists the node’s tags and filters by the one clicked, without adding it twice', async () => {
    const wrapper = await panel();
    const files = useFilesStore();
    const tags = wrapper.findAll('button').filter((button) => ['design', 'q3'].includes(button.text()));
    expect(tags).toHaveLength(2);

    await tags[0].trigger('click');
    expect(files.filter.tags).toEqual(['design']);
    await tags[0].trigger('click');
    expect(files.filter.tags).toEqual(['design']);
    await tags[1].trigger('click');
    expect(files.filter.tags).toEqual(['design', 'q3']);
  });

  // Home is a page of sections, not a listing: a filter set from the panel there has nothing to narrow, so it is
  // applied to the folder the node lives in and the page follows it.
  it('lands on the node’s folder when the page it was opened from has no listing', async () => {
    const files = useFilesStore();
    files.leave();
    const wrapper = await panel();
    const push = vi.spyOn(router, 'push');

    await row(wrapper, 'Owner').find('button').trigger('click');
    await flushPromises();
    // The filter travels in the ADDRESS, not in the store: the page it lands on reads its chips off the query
    // like any other arrival, so nothing here has to survive the navigation.
    expect(push).toHaveBeenCalledWith({ name: 'files', params: { path: ['Docs'] }, query: { owner: 'u7' } });
    expect(files.filter.personId).toBeNull();
  });

  // Owning a node is not a grant row, so the permissions answer never names the owner: without them the section
  // stood empty over a person's own files.
  it('lists the owner among the people with access, ahead of the grants', async () => {
    const user: User = { id: 'u7', name: 'Ann', initial: 'A', email: 'ann@example.com', role: 'member' };
    const wrapper = mount(DetailsPanel, {
      props: {
        node: file,
        path: [folder],
        people: [{ id: 'u9', name: 'Bo', initial: 'B', role: 'editor', principal: 'user' }],
        user,
      },
      global: { plugins: [i18n, router] },
    });
    await flushPromises();

    const people = wrapper.findAll('h3').find((heading) => heading.text() === 'People with access')!.element.nextElementSibling!;
    expect([...people.querySelectorAll('li')].map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'AYouOwner',
      'BBoEditor',
    ]);
  });

  it('offers no filter for a property nothing can be asked about', async () => {
    const wrapper = mount(DetailsPanel, {
      props: { node: folder, path: [], people: [], user: null },
      global: { plugins: [i18n, router] },
    });
    await flushPromises();
    // A folder has no size band and no type group, and with no path there is no location to open.
    expect(row(wrapper, 'Size').find('button').exists()).toBe(false);
    expect(row(wrapper, 'Type').find('button').exists()).toBe(false);
    expect(row(wrapper, 'Location').find('button').exists()).toBe(false);
  });
});
