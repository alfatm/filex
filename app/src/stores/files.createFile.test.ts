import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { useUndoStore } from '@/features/files/undoStore';
import { useFilesStore } from './files';

const folder: Node = { id: 'main://Docs', name: 'Docs', kind: 'folder', parentId: 'main://', size: 0, ownerId: 'u1', shared: false, starred: false };
const file: Node = { id: 'main://Docs/Untitled.txt', name: 'Untitled.txt', kind: 'file', parentId: 'main://Docs', size: 0, ownerId: 'u1', shared: false, starred: false };

describe('files.createFile', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(repository, 'getNode').mockResolvedValue(folder);
    vi.spyOn(repository, 'getPath').mockResolvedValue([]);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFilterPeople').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses before a folder or a drive is known', async () => {
    const createFile = vi.spyOn(repository, 'createFile').mockResolvedValue(file);
    await expect(useFilesStore().createFile('Untitled.txt')).rejects.toThrow('storage not loaded');
    expect(createFile).not.toHaveBeenCalled();
  });

  it('creates in the open folder, selects the new file and arms Undo', async () => {
    // The listing is empty until the file lands; the re-read after the mutation is what brings it in.
    const listFolder = vi.spyOn(repository, 'listFolder').mockResolvedValueOnce({ nodes: [], total: 0 }).mockResolvedValue({ nodes: [file], total: 1 });
    const createFile = vi.spyOn(repository, 'createFile').mockResolvedValue(file);
    const files = useFilesStore();
    await files.open(folder.id);

    const node = await files.createFile('Untitled.txt');

    expect(createFile).toHaveBeenCalledWith(folder.id, 'Untitled.txt');
    expect(node).toBe(file);
    expect(listFolder).toHaveBeenCalledTimes(2);
    expect(files.isSelected(file.id)).toBe(true);
    expect(files.selected.map((n) => n.id)).toEqual([file.id]);
    expect(useUndoStore().canUndo).toBe(true);
  });

  it('undoes by trashing the file it made', async () => {
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [file], total: 1 });
    vi.spyOn(repository, 'createFile').mockResolvedValue(file);
    const moveToTrash = vi.spyOn(repository, 'moveToTrash').mockResolvedValue(undefined);
    const files = useFilesStore();
    await files.open(folder.id);
    await files.createFile('Untitled.txt');

    await useUndoStore().undo();
    expect(moveToTrash).toHaveBeenCalledWith([file.id]);
  });
});
