import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useUploadStore } from './uploadStore';
import { useNodeDrag } from './useNodeDrag';

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath(null, '');
  return { files, uploads: useUploadStore(), drag: useNodeDrag() };
}

/**
 * What a drop hands over. A dropped FOLDER is in `files` too, as a zero-length entry named after it — `items` is
 * the only place the two can be told apart.
 */
function dropEvent(entries: { file?: File; folder?: string }[]) {
  const dataTransfer = {
    files: entries.map((e) => e.file ?? new File([], e.folder ?? '')),
    items: entries.map((e) => ({
      kind: 'file',
      getAsFile: () => e.file ?? null,
      webkitGetAsEntry: () => (e.folder ? { isDirectory: true, name: e.folder } : { isDirectory: false, name: e.file?.name }),
    })),
    types: ['Files'],
  };
  return { dataTransfer, preventDefault: () => {}, stopPropagation: () => {} } as unknown as DragEvent;
}

describe('useNodeDrag', () => {
  // A dropped folder arrives in `files` as a zero-length entry named after it. The store leaves those out, but it
  // needs the whole transfer to see them — this handler used to hand over the file list alone, and the folder was
  // uploaded as an empty file.
  it('sends nothing to the server when a folder is dropped on a folder card', async () => {
    const { files, uploads, drag } = await setup();
    const target = files.folders[0];
    const uploaded = vi.spyOn(repository, 'uploadFile');

    const event = dropEvent([{ folder: 'Screenshots' }]);
    drag.onDragOver(target, event);
    await drag.onDrop(target, event);

    expect(uploaded).not.toHaveBeenCalled();
    expect(uploads.items).toHaveLength(0);
    uploaded.mockRestore();
  });

  it('still uploads the files dropped beside it', async () => {
    const { files, uploads, drag } = await setup();
    const target = files.folders[0];

    const event = dropEvent([{ folder: 'Screenshots' }, { file: new File(['x'], 'shot.png') }]);
    drag.onDragOver(target, event);
    await drag.onDrop(target, event);

    expect(uploads.items.map((i) => i.name)).toEqual(['shot.png']);
  });
});
