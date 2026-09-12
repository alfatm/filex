import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { noCapabilities, ROLE_PERMISSIONS, type Node } from '@/data/types';
import { useModalsStore } from '@/features/files/modalsStore';
import { i18n } from '@/i18n';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { createMemoryHistory, createRouter } from 'vue-router';
import { breakpointMock, setLayout } from '@/test/viewport';
import SelectionBar from './SelectionBar.vue';

vi.mock('@/composables/useBreakpoint', async () => (await import('@/test/viewport')).breakpointMock);
void breakpointMock;

const FOLDER = 'demo://Docs';
const folder: Node = { id: FOLDER, name: 'Docs', kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'u1', shared: false, starred: false };
/** `useFileActions`, behind the Download icon, injects the router. */
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { template: '<div />' } }] });

const file: Node = { id: `${FOLDER}/a.md`, name: 'a.md', kind: 'file', parentId: FOLDER, size: 3, ownerId: 'u1', shared: false, starred: false };

describe('the selection bar under role permissions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [file], total: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  /** The bar over a one-file selection, with every installation feature on and `withheld` taken off the role. */
  async function bar(withheld: string[]) {
    const files = useFilesStore();
    await files.open(FOLDER);
    files.select(file.id);
    useCapabilitiesStore().can = {
      ...noCapabilities(),
      delete: true,
      move: true,
      copy: true,
      folderDownload: true,
      deleteForever: true,
      allowed: new Set(ROLE_PERMISSIONS.filter((id) => !withheld.includes(id))),
    };
    const wrapper = mount(SelectionBar, { global: { plugins: [i18n, router] } });
    await flushPromises();
    return wrapper;
  }

  /*
   * The gate used to be passed as `disabled-hint` alone, which only writes `aria-disabled` and a tooltip: the
   * button stayed clickable, so a role without `files.delete` got the tooltip AND the delete modal, and the
   * request the modal sent came back 403 as a toast.
   */
  it('does not act on an icon whose gate says the role may not, and says so on the button', async () => {
    const wrapper = await bar(['files.delete']);
    const modals = useModalsStore();
    const open = vi.spyOn(modals, 'open');
    const trash = wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'Delete')!;

    // Both ways of pressing it: the wrapper's own, and the click a person's pointer produces on the element.
    await trash.trigger('click');
    (trash.element as HTMLButtonElement).click();
    await flushPromises();

    expect(open).not.toHaveBeenCalled();
    expect(modals.active).toBeNull();
    // And the button says why, rather than only looking pressable.
    expect(trash.attributes('title')).toBe('Your role may not do this');
    expect(trash.attributes('disabled')).toBeDefined();
  });

  // The row menu had "Copy to" all along; the bar did not, so duplicating several files at once was the one thing
  // a multi-selection could not do.
  it('offers the same Copy to the whole selection that a single row has', async () => {
    const wrapper = await bar([]);
    const modals = useModalsStore();
    const copy = wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'Copy to')!;

    expect(copy.attributes('disabled')).toBeUndefined();
    await copy.trigger('click');
    expect(modals.active).toMatchObject({ kind: 'copy' });
  });

  it('still acts on the same icon for a role that carries the permission', async () => {
    const wrapper = await bar([]);
    const modals = useModalsStore();
    const trash = wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'Delete')!;

    expect(trash.attributes('disabled')).toBeUndefined();
    await trash.trigger('click');
    expect(modals.active).toMatchObject({ kind: 'delete', variant: 'trash' });
  });
});

describe('the selection bar on a phone', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [file], total: 1 });
  });
  afterEach(() => {
    setLayout('desktop');
    vi.restoreAllMocks();
  });

  async function phoneBar() {
    setLayout('mobile');
    const files = useFilesStore();
    await files.open(FOLDER);
    files.select(file.id);
    useCapabilitiesStore().can = { ...noCapabilities(), delete: true, move: true, copy: true, folderDownload: true, allowed: new Set(ROLE_PERMISSIONS) };
    const wrapper = mount(SelectionBar, { attachTo: document.body, global: { plugins: [i18n, router] } });
    await flushPromises();
    return wrapper;
  }

  /*
   * Measured at 390: the bar draws a count, seven icons and a clear button in ~300px, and the last three were
   * painted past its right edge where nothing could reach them. Three stay, the rest move under ⋮ (spec §10).
   */
  it('keeps three actions and puts the rest under a menu', async () => {
    const wrapper = await phoneBar();
    const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));

    expect(labels).toContain('More');
    expect(labels).not.toContain('Delete');

    await wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'More')!.trigger('click');
    await flushPromises();
    expect([...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent?.trim() ?? '')).toContain('Delete');
    wrapper.unmount();
  });

  it('draws every action at the design width', async () => {
    const files = useFilesStore();
    await files.open(FOLDER);
    files.select(file.id);
    useCapabilitiesStore().can = { ...noCapabilities(), delete: true, move: true, copy: true, folderDownload: true, allowed: new Set(ROLE_PERMISSIONS) };
    const wrapper = mount(SelectionBar, { global: { plugins: [i18n, router] } });
    await flushPromises();

    const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));
    expect(labels).toContain('Delete');
    expect(labels).not.toContain('More');
    wrapper.unmount();
  });
});
