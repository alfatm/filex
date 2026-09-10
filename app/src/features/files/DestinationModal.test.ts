import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import type { Node, Storage } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import DestinationModal from './DestinationModal.vue';

const folder = (id: string, name: string, parentId: string | null): Node => ({
  id,
  name,
  kind: 'folder',
  parentId,
  size: 0,
  ownerId: 'u1',
  shared: false,
  starred: false,
});

const drive = (id: string): Storage => ({ id, name: id, rootId: `${id}://`, quota: { usedBytes: 0, totalBytes: 100 }, shared: false });

/**
 * Two drives, and a store whose own drive is the HOME one — which is what Starred, Recent and Shared leave it as.
 * The nodes being moved live on the other one.
 */
async function setup(nodes: Node[], mode: 'move' | 'copy') {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const files = useFilesStore();
  await files.bootstrap();
  files.storages = [drive('main'), drive('archive')];
  const wrapper = mount(DestinationModal, { attachTo: document.body, props: { nodes, mode }, global: { plugins: [i18n] } });
  await flushPromises();
  return { wrapper, files };
}

/** The dialog is teleported out of the wrapper, so the document is what holds it. */
const driveOptions = () => [...document.querySelectorAll('option')].map((o) => [o.value, o.disabled] as const);
const driveLabels = () => [...document.querySelectorAll('option')].map((o) => o.textContent);
const folderRows = () => [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')];

describe('DestinationModal', () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
    vi.restoreAllMocks();
  });

  // The source drive used to be taken from the open listing. On the flat listings that is the home drive whatever
  // the rows are, so copying something off another mount greyed out every drive except the one it cannot go to.
  it('reads the drive a copy may not leave from the nodes, not from the listing behind them', async () => {
    const { wrapper, files } = await setup([folder('archive://2025', '2025', 'archive://')], 'copy');
    close = () => wrapper.unmount();
    expect(files.storage?.id).toBe('main');

    expect(driveOptions()).toEqual([
      ['main', true],
      ['archive', false],
    ]);
  });

  it('offers no destination drive at all for a copy of nodes that span two of them', async () => {
    const { wrapper } = await setup([folder('archive://2025', '2025', 'archive://'), folder('main://Docs', 'Docs', 'main://')], 'copy');
    close = () => wrapper.unmount();
    expect(driveOptions().every(([, disabled]) => disabled)).toBe(true);
  });

  /**
   * The highlight moved off the `main` constant onto the store's `homeStorageId`; this label did not, so on a
   * dataset with no drive called `main` no option was marked as the home drive.
   */
  it('labels the home drive as the home whatever it is called', async () => {
    const { wrapper, files } = await setup([folder('archive://2025', '2025', 'archive://')], 'move');
    close = () => wrapper.unmount();
    files.storages = [drive('demo'), drive('archive')];
    await nextTick();

    expect(driveLabels()).toEqual(['demo — home folder', 'archive']);
  });

  // The tree blocks a folder's whole subtree by walking into it. A filter answers with a flat list and no walk, so
  // a hit INSIDE the folder being moved was offered as somewhere to move it to.
  it('blocks a filter hit that sits inside the folder being moved', async () => {
    const moved = folder('archive://Design', 'Design', 'archive://');
    const { wrapper } = await setup([moved], 'move');
    close = () => wrapper.unmount();

    vi.spyOn(repository, 'searchFolders').mockResolvedValue([
      folder('archive://Design/Assets', 'Assets', 'archive://Design'),
      folder('archive://Reports', 'Reports', 'archive://'),
    ]);
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = 'e';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushPromises();

    // The name span; the one beside it carries the hit's location.
    expect(folderRows().map((r) => [r.querySelector('span.truncate')?.textContent, r.disabled])).toEqual([
      ['Assets', true],
      ['Reports', false],
    ]);
  });
});
