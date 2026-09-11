import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { NOT_FOUND } from '@/data/repository';
import { noQuota, type Node, type Storage } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AdvancedSearchModal from './AdvancedSearchModal.vue';
import { fromUrlQuery, toUrlQuery, useSearchStore } from './searchStore';

const Page = { template: '<div />' };

async function setup(startAt = '/files') {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/files/:path*', name: 'files', component: Page },
      { path: '/search', name: 'search', component: Page },
    ],
  });
  await router.push(startAt);
  await useFilesStore().bootstrap();
  const store = useSearchStore();
  const wrapper = mount(AdvancedSearchModal, { attachTo: document.body, global: { plugins: [router, i18n] } });
  return { router, store, wrapper };
}

// Headless UI renders the dialog through a portal, so look the fields up on the document.
const field = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

async function setField(label: string, value: string) {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('AdvancedSearchModal', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it('accepts numeric Min/Max bounds and submits on Enter in Min', async () => {
    const { router, store, wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    store.openModal('brief');
    await flushPromises();
    expect(field('Min')).toBeTruthy();

    await setField('Min', '10');
    await setField('Max', '20');
    expect(store.query.size).toMatchObject({ min: 10, max: 20 });
    await setField('Max', '');
    expect(store.query.size.max).toBeNull();

    field('Min').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect(store.open).toBe(false);
    expect(router.currentRoute.value.name).toBe('search');
    expect(router.currentRoute.value.query).toMatchObject({ q: 'brief', min: '10' });
  });

  it('shows the folder from the query and toggles content options through their labels', async () => {
    const { store, wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    store.openModal(undefined, 'Design/Assets');
    await flushPromises();
    expect(document.body.textContent).toContain('Current folder: Assets');

    const checkbox = [...document.body.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
      (el) => el.closest('label')?.textContent?.includes('Match whole phrase'),
    )!;
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    // The visible text is the control's <label>, so it names the box (and, in browsers, toggles it).
    expect(checkbox.hasAttribute('aria-label')).toBe(false);
    checkbox.click();
    await nextTick();
    expect(store.query.wholePhrase).toBe(true);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });

  it('cancel on /search puts the URL query back', async () => {
    const { router, store, wrapper } = await setup('/search?q=brief&tags=design');
    cleanup = () => wrapper.unmount();
    store.assign(fromUrlQuery(router.currentRoute.value.query));
    store.openModal();
    await flushPromises();

    await setField('Min', '3');
    store.query.text = 'changed';
    store.query.tags = [];
    await flushPromises();
    expect(store.query.text).toBe('changed');

    button('Cancel').click();
    await flushPromises();
    expect(store.open).toBe(false);
    expect(store.query).toEqual(fromUrlQuery({ q: 'brief', tags: 'design' }));
  });
});

describe('the date window in the advanced search', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it('carries the window through the URL the way the listing chips spell it', async () => {
    const { router, store, wrapper } = await setup('/search?date=created&at=2026-09-09T12:00:00.000Z&span=week');
    cleanup = () => wrapper.unmount();
    store.assign(fromUrlQuery(router.currentRoute.value.query));
    expect(store.query.around).toEqual({ field: 'created', at: '2026-09-09T12:00:00.000Z', span: 'week' });
    expect(toUrlQuery(store.query)).toMatchObject({ date: 'created', at: '2026-09-09T12:00:00.000Z', span: 'week' });
  });

  it('lets the preset and the window replace each other: one column cannot answer two windows', async () => {
    const { store, wrapper } = await setup('/search?modified=week');
    cleanup = () => wrapper.unmount();
    store.query.modified = 'week';
    store.openModal();
    await flushPromises();

    await setField('Date', '2026-09-09');
    expect(store.query.modified).toBe('any');
    expect(store.query.around).toMatchObject({ field: 'modified', span: 'day' });
    // Noon of the day picked, so "±1 day" covers that day with a night either side.
    expect(new Date(store.query.around!.at).getHours()).toBe(12);

    await setField('Date', '');
    expect(store.query.around).toBeNull();
  });

  it('reads the Path box either way, and says which way in the hint', async () => {
    const { store, wrapper } = await setup('/search');
    cleanup = () => wrapper.unmount();
    store.openModal();
    await flushPromises();

    await setField('Path', '/demo/archive/');
    expect(store.query.pathMode).toBe('only');
    expect(document.body.textContent).toContain('Search only inside this folder');

    button('Skip this').click();
    await nextTick();
    expect(store.query.pathMode).toBe('skip');
    // The hint follows the mode: the same box now means the opposite, and the only place that shows is here.
    expect(document.body.textContent).toContain('Leave this folder out of the results');
    // The mode rides in the URL beside the path, so a shared link means what it meant.
    expect(toUrlQuery(store.query)).toMatchObject({ path: '/demo/archive/', pathmode: 'skip' });
  });

  it('says so when the Path box names a folder that is not there', async () => {
    const drive: Storage = { id: 'demo', serverId: 4, name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] };
    vi.spyOn(repository, 'listStorages').mockResolvedValue([drive]);
    // bootstrap loads the drives and the user together; a rejected user leaves `storages` empty, and then every
    // path would read as an unknown drive.
    vi.spyOn(repository, 'currentUser').mockResolvedValue({ id: 'u1', name: 'Me', initial: 'M', email: 'me@filex.test', role: 'member' });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    const resolvePath = vi.spyOn(repository, 'resolvePath');
    const { wrapper } = await setup('/search');
    cleanup = () => {
      wrapper.unmount();
      vi.restoreAllMocks();
    };
    useSearchStore().openModal();
    await flushPromises();

    // A path that names nothing is invisible in a result list: confining to it answers with nothing, and
    // excluding it removes nothing — and no count tells the two apart.
    resolvePath.mockRejectedValueOnce(new Error(NOT_FOUND));
    await setField('Path', '/demo/nope/');
    field('Path').dispatchEvent(new Event('blur'));
    await flushPromises();
    expect(document.body.textContent).toContain('No such folder');

    // The drive is answered without asking anything — the app already holds every drive this account can open.
    await setField('Path', '/nosuchdrive/x/');
    field('Path').dispatchEvent(new Event('blur'));
    await flushPromises();
    expect(document.body.textContent).toContain('No such drive');
    expect(resolvePath).toHaveBeenCalledTimes(1);

    // A folder that IS there puts the hint back.
    resolvePath.mockResolvedValueOnce({ id: 'demo://Design', name: 'Design', kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'u1', shared: false, starred: false } as Node);
    await setField('Path', '/demo/Design/');
    field('Path').dispatchEvent(new Event('blur'));
    await flushPromises();
    expect(document.body.textContent).not.toContain('No such folder');
  });
});
