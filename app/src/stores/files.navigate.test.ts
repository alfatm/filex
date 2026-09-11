import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { FORBIDDEN, NOT_FOUND } from '@/data/repository';
import type { Node } from '@/data/types';
import { useFilesStore } from './files';

const folderNode = (id: string, name: string): Node => ({
  id,
  name,
  kind: 'folder',
  parentId: 'main://',
  size: 0,
  ownerId: 'u1',
  shared: false,
  starred: false,
});
const fileNode = (parentId: string, name: string): Node => ({
  id: `${parentId}/${name}`,
  name,
  kind: 'file',
  parentId,
  size: 10,
  ownerId: 'u1',
  shared: false,
  starred: false,
});

const DOCS = 'main://Docs';
const PHOTOS = 'main://Photos';

describe('navigating between folders', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'getNode').mockImplementation(async (id: string) => folderNode(id, id.split('/').pop()!));
  });
  afterEach(() => vi.restoreAllMocks());

  it('drops the previous folder rows while the next one is on its way', async () => {
    vi.spyOn(repository, 'listFolder').mockImplementation(async (id: string) => ({
      nodes: [fileNode(id, `${id}.md`)],
      total: 1,
    }));
    const files = useFilesStore();
    await files.open(DOCS);
    expect(files.ordered).toHaveLength(1);

    const next = files.open(PHOTOS);
    // The page draws its skeleton off these two: rows of the folder being left would show under the new one.
    expect(files.loading).toBe(true);
    expect(files.ordered).toEqual([]);
    await next;
    expect(files.ordered.map((n) => n.name)).toEqual([`${PHOTOS}.md`]);
  });

  it('keeps the rows while the SAME folder is re-read after a mutation', async () => {
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [fileNode(DOCS, 'notes.md')], total: 1 });
    const files = useFilesStore();
    await files.open(DOCS);

    const again = files.refresh();
    expect(files.ordered).toHaveLength(1);
    await again;
    expect(files.ordered).toHaveLength(1);
  });

  it('clears the rows before the address of another folder is even resolved', async () => {
    vi.spyOn(repository, 'listStorages').mockResolvedValue([{ id: 'main', name: 'main', rootId: 'main://', kind: 'local' } as never]);
    vi.spyOn(repository, 'currentUser').mockResolvedValue({ id: 'u1', name: 'U', email: 'u@e' } as never);
    vi.spyOn(repository, 'listFolder').mockImplementation(async (id: string) => ({ nodes: [fileNode(id, 'a.md')], total: 1 }));
    let resolvePath!: (node: Node) => void;
    vi.spyOn(repository, 'resolvePath').mockImplementation(
      () => new Promise<Node>((resolve) => { resolvePath = resolve; }),
    );
    const files = useFilesStore();
    await files.bootstrap();

    const first = files.openPath('main', 'Docs');
    resolvePath(folderNode(DOCS, 'Docs'));
    await first;
    expect(files.ordered).toHaveLength(1);

    const second = files.openPath('main', 'Photos');
    // Resolving the address is a request of its own; nothing of the old folder may survive it.
    expect(files.loading).toBe(true);
    expect(files.ordered).toEqual([]);
    resolvePath(folderNode(PHOTOS, 'Photos'));
    await second;
    expect(files.ordered).toHaveLength(1);
  });
});

/**
 * The three sentences a failed address gets. They used to be two: `resolvePath` answered 403 and 404 alike with
 * `NOT_FOUND`, so a folder somebody simply may not read was reported as one that "may have been renamed, moved or
 * deleted" — and the page offered Try again for a request that will be refused every time.
 */
describe('what a refused address says', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'listStorages').mockResolvedValue([{ id: 'main', name: 'main', rootId: 'main://', kind: 'local' } as never]);
    vi.spyOn(repository, 'currentUser').mockResolvedValue({ id: 'u1', name: 'U', email: 'u@e' } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [NOT_FOUND, 'notFound'],
    [FORBIDDEN, 'forbidden'],
    ['500: upstream exploded', 'load'],
  ])('answers %s with the %s state', async (thrown, expected) => {
    vi.spyOn(repository, 'resolvePath').mockRejectedValue(new Error(thrown));
    const files = useFilesStore();
    await files.bootstrap();

    await files.openPath('main', 'Docs');
    expect(files.error).toBe(expected);
    expect(files.ordered).toEqual([]);
  });
});
