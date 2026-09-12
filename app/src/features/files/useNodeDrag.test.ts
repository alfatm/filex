import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { useUploadStore } from './uploadStore';
import { useNodeDrag } from './useNodeDrag';

const folder: Node = { id: 'demo://Docs', name: 'Docs', kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'u1', shared: false, starred: false };
const file: Node = { id: 'demo://a.png', name: 'a.png', kind: 'file', parentId: 'demo://', size: 3, ownerId: 'u1', shared: false, starred: false };

/**
 * A transfer that carries BOTH the app's own drag and a file list — what a card grabbed by its picture used to
 * hand over, because the browser ran its own image drag alongside the card's.
 */
function transfer(types: string[]) {
  return { types, files: types.includes('Files') ? [new File([''], 'a.png')] : [], effectAllowed: 'move', dropEffect: 'none', setData: () => {} } as unknown as DataTransfer;
}

function event(dataTransfer: DataTransfer) {
  return { dataTransfer, preventDefault: () => {}, stopPropagation: () => {} } as unknown as DragEvent;
}

describe('a drag that started in the app', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('asks for a move even when the transfer also carries files', () => {
    const { drag, onDragStart, onDragOver } = useNodeDrag();
    const dt = transfer(['text/plain', 'Files']);
    onDragStart(file, event(dt));
    onDragOver(folder, event(dt));
    // `copy` here contradicts the `effectAllowed` of `move` the drag start asked for, and the browser answers that
    // contradiction with a refused drop over a folder it has just highlighted.
    expect(dt.dropEffect).toBe('move');
    expect(drag.overId).toBe(folder.id);
  });

  it('moves the node rather than uploading what the transfer picked up', async () => {
    const files = useFilesStore();
    const move = vi.spyOn(files, 'move').mockResolvedValue(undefined);
    const upload = vi.spyOn(useUploadStore(), 'start').mockResolvedValue(undefined);
    const { onDragStart, onDragOver, onDrop } = useNodeDrag();
    const dt = transfer(['text/plain', 'Files']);
    onDragStart(file, event(dt));
    onDragOver(folder, event(dt));
    await onDrop(folder, event(dt));
    expect(move).toHaveBeenCalledWith([file], folder);
    expect(upload).not.toHaveBeenCalled();
  });

  it('still uploads a drag that brought only files', async () => {
    const upload = vi.spyOn(useUploadStore(), 'start').mockResolvedValue(undefined);
    const { onDragOver, onDrop } = useNodeDrag();
    const dt = transfer(['Files']);
    onDragOver(folder, event(dt));
    expect(dt.dropEffect).toBe('copy');
    await onDrop(folder, event(dt));
    expect(upload).toHaveBeenCalledWith(dt, folder.id);
  });
});
