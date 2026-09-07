import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMock } from '@/data/mock';
import { useFilesStore } from '@/stores/files';
import { UPLOAD_MS, useUploadStore } from './uploadStore';

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath('');
  return { files, uploads: useUploadStore() };
}

const file = (name: string) => new File(['x'], name);

/** What a folder picker hands over: a flat list whose files remember where they sat in the tree. */
function inFolder(relativePath: string): File {
  const node = new File(['x'], relativePath.split('/').pop()!);
  Object.defineProperty(node, 'webkitRelativePath', { value: relativePath });
  return node;
}

describe('upload store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes files after UPLOAD_MS and adds them to the open folder', async () => {
    const { files, uploads } = await setup();
    await uploads.start([file('a.txt')]);
    expect(uploads.open).toBe(true);
    expect(uploads.doneCount).toBe(0);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS);
    expect(uploads.doneCount).toBe(1);
    expect(files.ordered.map((n) => n.name)).toContain('a.txt');
  });

  it('rebuilds the folder tree of an uploaded folder, reusing folders that already exist', async () => {
    const { files, uploads } = await setup();
    await uploads.start([inFolder('Trip/a.txt'), inFolder('Trip/raw/b.txt'), inFolder('Trip/raw/c.txt')]);
    // The tree exists before the first byte "arrives".
    expect(files.ordered.map((n) => n.name)).toContain('Trip');

    await vi.advanceTimersByTimeAsync(UPLOAD_MS);
    const trip = files.ordered.find((n) => n.name === 'Trip')!;
    await files.open(trip.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['a.txt', 'raw']);
    const raw = files.ordered.find((n) => n.name === 'raw')!;
    await files.open(raw.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['b.txt', 'c.txt']);

    // A second upload into the same tree reuses both folders instead of failing on the duplicate name.
    await files.openPath('');
    await uploads.start([inFolder('Trip/raw/d.txt')]);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS);
    expect(files.ordered.filter((n) => n.name === 'Trip')).toHaveLength(1);
    await files.open(raw.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  it('clear() mid-flight keeps the in-flight upload running and drops finished rows only', async () => {
    const { files, uploads } = await setup();
    await uploads.start([file('first.txt')]);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS);
    await uploads.start([file('second.txt')]);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS / 2);
    expect(uploads.items.map((i) => i.done)).toEqual([true, false]);

    uploads.clear();
    expect(uploads.items.map((i) => i.name)).toEqual(['second.txt']);
    expect(uploads.open).toBe(true);

    await vi.advanceTimersByTimeAsync(UPLOAD_MS / 2);
    expect(uploads.doneCount).toBe(1);
    expect(files.ordered.map((n) => n.name)).toEqual(expect.arrayContaining(['first.txt', 'second.txt']));
    uploads.clear();
    expect(uploads.open).toBe(false);
  });
});
