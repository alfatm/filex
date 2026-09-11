import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { emptyFilter } from '@/features/files/filters';
import { useFilesStore } from './files';

const FOLDER = 'main://Docs';
const folder: Node = { id: FOLDER, name: 'Docs', kind: 'folder', parentId: 'main://', size: 0, ownerId: 'u1', shared: false, starred: false };
const node = (name: string, patch: Partial<Node> = {}): Node => ({
  id: `${FOLDER}/${name}`,
  name,
  kind: 'file',
  parentId: FOLDER,
  size: 10,
  ownerId: 'u1',
  shared: false,
  starred: false,
  fileType: name.endsWith('.png') ? 'image' : 'md',
  ...patch,
});
const rows = [node('notes.md'), node('photo.png'), node('Reports', { kind: 'folder', size: 0, fileType: undefined })];

describe('filter chips on the folder listing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sieves a small folder in memory: one request, whatever the chips do', async () => {
    const list = vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: rows, total: 3 });
    const files = useFilesStore();
    await files.open(FOLDER);
    expect(list).toHaveBeenCalledTimes(1);
    expect(files.total).toBe(3);

    await files.setFilter({ ...emptyFilter(), fileType: 'images' });
    expect(list).toHaveBeenCalledTimes(1);
    expect(files.ordered.map((n) => n.name)).toEqual(['photo.png']);
    expect(files.filtered).toBe(true);

    await files.setName('rep');
    expect(list).toHaveBeenCalledTimes(1);
    // The name box keeps folders and the Type chip is still on: nothing is both an image and named "rep".
    expect(files.ordered).toEqual([]);
    await files.clearFilter();
    expect(list).toHaveBeenCalledTimes(1);
    expect(files.ordered).toHaveLength(3);
    // The whole folder is still in memory: the sieve never touched it.
    expect(files.items).toHaveLength(3);
  });

  it('asks the server again for every chip on a large folder', async () => {
    const list = vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: rows, total: 1500 });
    const files = useFilesStore();
    await files.open(FOLDER);
    expect(files.total).toBe(1500);

    const filter = { ...emptyFilter(), fileType: 'images' as const };
    await files.setFilter(filter);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(FOLDER, filter);
    // What the server answered is what is shown, unsieved.
    expect(files.ordered).toHaveLength(3);
  });

  it('waits for the typing to pause before a large folder is asked by name', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const list = vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: rows, total: 1500 });
    const files = useFilesStore();
    await files.open(FOLDER);

    await files.setName('r');
    await files.setName('re');
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(FOLDER, { ...emptyFilter(), name: 're' });
  });

  // The pending debounce belonged to the folder being left. It calls `refresh()`, which reads the CURRENT listing —
  // still the old folder until the new load resolves — so firing it reloaded the old folder and the navigation was
  // dropped as the stale request: the person ended up in the folder they had just clicked away from.
  it('drops a pending name search when the listing is navigated away from', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const other = 'main://Photos';
    const list = vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: rows, total: 1500 });
    vi.spyOn(repository, 'getNode').mockImplementation(async (id) => ({ ...folder, id, name: id.split('/').pop() as string }));
    const files = useFilesStore();
    await files.open(FOLDER);

    await files.setName('re');
    const openedOther = files.open(other);
    await vi.advanceTimersByTimeAsync(300);
    await openedOther;
    await flushPromises();

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(other, expect.anything());
    expect(files.folder?.id).toBe(other);
  });

  it('opens a small folder whole when a chip is already on, so the sieve has the whole folder to work on', async () => {
    const list = vi.spyOn(repository, 'listFolder').mockImplementation(async (_id, filter) => ({
      nodes: filter?.fileType === 'images' ? [rows[1]] : rows,
      total: 3,
    }));
    const files = useFilesStore();
    files.filter = { ...emptyFilter(), fileType: 'images' };
    await files.open(FOLDER);
    // Once with the chip — which is what said the folder is small — and once more for all of it.
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(FOLDER, emptyFilter());
    expect(files.items).toHaveLength(3);
    expect(files.ordered.map((n) => n.name)).toEqual(['photo.png']);
  });
});
