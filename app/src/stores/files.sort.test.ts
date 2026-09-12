import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import type { FileType, Node } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from './files';
import { useViewStore } from './view';

const FOLDER = 'main://Docs';

const file = (name: string, fileType: FileType = 'other'): Node => ({
  id: `${FOLDER}/${name}`,
  name,
  kind: 'file',
  parentId: FOLDER,
  size: 10,
  ownerId: 'u1',
  shared: false,
  starred: false,
  fileType,
});

async function listing(nodes: Node[]) {
  vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes, total: nodes.length });
  const files = useFilesStore();
  await files.open(FOLDER);
  return files;
}

describe('the order rows are listed in', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'getNode').mockResolvedValue({ ...file('Docs'), kind: 'folder', id: FOLDER });
  });
  afterEach(() => vi.restoreAllMocks());

  // Lexicographic order put `file 10` before `file 2`, which is not an order anyone names files for: a folder of
  // `IMG_2 … IMG_10` came out shuffled. `numeric` reads a digit run as the number it is.
  it('reads a run of digits in a name as a number', async () => {
    const view = useViewStore();
    view.sortKey = 'name';
    view.sortDir = 'asc';
    const files = await listing([file('file 100.txt'), file('file 2.txt'), file('file 10.txt'), file('IMG_9.png'), file('IMG_10.png')]);
    expect(files.ordered.map((n) => n.name)).toEqual(['file 2.txt', 'file 10.txt', 'file 100.txt', 'IMG_9.png', 'IMG_10.png']);
  });

  it('still ignores case and still reverses', async () => {
    const view = useViewStore();
    view.sortKey = 'name';
    view.sortDir = 'asc';
    const files = await listing([file('cherry.txt'), file('Banana.txt'), file('apple.txt')]);
    expect(files.ordered.map((n) => n.name)).toEqual(['apple.txt', 'Banana.txt', 'cherry.txt']);
    view.sortDir = 'desc';
    expect(files.ordered.map((n) => n.name)).toEqual(['cherry.txt', 'Banana.txt', 'apple.txt']);
  });

  // By the LABEL the Type column prints, so what a person sorts by is what they read; rows of one type keep a
  // stable order of their own, which is the name.
  it('groups by the type the column names, and orders each group by name', async () => {
    const view = useViewStore();
    view.sortKey = 'type';
    view.sortDir = 'asc';
    const files = await listing([file('z.pdf', 'pdf'), file('b.png', 'image'), file('a.pdf', 'pdf'), file('c.png', 'image')]);
    // "Image" before "PDF document"; within each, the name.
    expect(files.ordered.map((n) => n.name)).toEqual(['b.png', 'c.png', 'a.pdf', 'z.pdf']);
    view.sortDir = 'desc';
    expect(files.ordered.map((n) => n.name)).toEqual(['a.pdf', 'z.pdf', 'b.png', 'c.png']);
  });
});
