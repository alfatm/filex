import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from './files';
import { useToastStore } from './toast';

const FOLDER = 'main://Docs';

const file = (name: string): Node => ({
  id: `${FOLDER}/${name}`,
  name,
  kind: 'file',
  parentId: FOLDER,
  size: 10,
  ownerId: 'u1',
  shared: false,
  starred: false,
});

async function listing(nodes: Node[]) {
  vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes, total: nodes.length });
  const files = useFilesStore();
  await files.open(FOLDER);
  return files;
}

describe('what a move says once it has happened', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
    vi.spyOn(repository, 'getNode').mockResolvedValue({ ...file('Docs'), kind: 'folder', id: FOLDER });
  });
  afterEach(() => vi.restoreAllMocks());

  // The step was recorded all along and Ctrl+Z ran it — only the toast said nothing about it, while the trash
  // toast did. A move takes the rows off the open folder, so it is exactly the one that needs the way back.
  it('offers the undo it has already armed', async () => {
    vi.spyOn(repository, 'move').mockResolvedValue(undefined);
    const files = await listing([file('a.md')]);
    const toast = useToastStore();
    const target: Node = { ...file('Archive'), kind: 'folder', id: 'main://Archive', parentId: 'main://' };

    await files.move([files.ordered[0]], target);

    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0].text).toContain('Archive');
    expect(toast.toasts[0].action?.label).toBe('Undo');
  });
});
