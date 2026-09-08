import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { MOCK_UPLOAD_MS, resetMock } from '@/data/mock';
import { useFilesStore } from '@/stores/files';
import { useUploadStore } from './uploadStore';

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

/**
 * A localStorage of our own: this Node build's happy-dom does not provide one, and the store's records — the only
 * thing that survives a reload — are exactly what these tests are about.
 */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('upload store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fills the row from the transfer’s own progress and adds the file once it lands', async () => {
    const { files, uploads } = await setup();
    await uploads.start([file('a.txt')]);
    expect(uploads.open).toBe(true);
    expect(uploads.doneCount).toBe(0);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(uploads.doneCount).toBe(1);
    expect(files.ordered.map((n) => n.name)).toContain('a.txt');
  });

  it('rebuilds the folder tree of an uploaded folder, reusing folders that already exist', async () => {
    const { files, uploads } = await setup();
    await uploads.start([inFolder('Trip/a.txt'), inFolder('Trip/raw/b.txt'), inFolder('Trip/raw/c.txt')]);
    // The tree exists before the first byte "arrives".
    expect(files.ordered.map((n) => n.name)).toContain('Trip');

    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    const trip = files.ordered.find((n) => n.name === 'Trip')!;
    await files.open(trip.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['a.txt', 'raw']);
    const raw = files.ordered.find((n) => n.name === 'raw')!;
    await files.open(raw.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['b.txt', 'c.txt']);

    // A second upload into the same tree reuses both folders instead of failing on the duplicate name.
    await files.openPath('');
    await uploads.start([inFolder('Trip/raw/d.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(files.ordered.filter((n) => n.name === 'Trip')).toHaveLength(1);
    await files.open(raw.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  it('clear() mid-flight keeps the in-flight upload running and drops finished rows only', async () => {
    const { files, uploads } = await setup();
    await uploads.start([file('first.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    await uploads.start([file('second.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS / 2);
    expect(uploads.items.map((i) => i.state)).toEqual(['done', 'running']);

    uploads.clear();
    expect(uploads.items.map((i) => i.name)).toEqual(['second.txt']);
    expect(uploads.open).toBe(true);

    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS / 2);
    expect(uploads.doneCount).toBe(1);
    expect(files.ordered.map((n) => n.name)).toEqual(expect.arrayContaining(['first.txt', 'second.txt']));
    uploads.clear();
    expect(uploads.open).toBe(false);
  });

  it('marks the row failed when the transfer never lands, and clear() drops it', async () => {
    const { files, uploads } = await setup();
    vi.spyOn(repository, 'uploadFile').mockRejectedValue(new Error('storage offline'));
    await uploads.start([file('a.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);

    // A row that stops at some percent for ever is worse than one that says it failed.
    expect(uploads.items.map((i) => i.state)).toEqual(['failed']);
    expect(uploads.doneCount).toBe(0);
    expect(files.ordered.map((n) => n.name)).not.toContain('a.txt');

    uploads.clear();
    expect(uploads.open).toBe(false);
  });

  it('cancelling stops the transfer, drops what the server staged and leaves the file out of the folder', async () => {
    const { files, uploads } = await setup();
    const aborted: string[] = [];
    vi.spyOn(repository, 'abortUpload').mockImplementation(async (id: string) => {
      aborted.push(id);
    });
    vi.spyOn(repository, 'uploadFile').mockImplementation(async (_parentId, _file, options) => {
      options?.onSession?.('sess-1');
      // Never resolves on its own: the only way out is the abort signal.
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    await uploads.start([file('big.bin')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(uploads.items[0].state).toBe('running');

    await uploads.cancel(uploads.items[0].id);
    await vi.advanceTimersByTimeAsync(1);
    expect(uploads.items[0].state).toBe('cancelled');
    // ⚠ The staged bytes are the server's disk and the account's quota; cancelling has to say so out loud.
    expect(aborted).toEqual(['sess-1']);
    expect(files.ordered.map((n) => n.name)).not.toContain('big.bin');
    expect(localStorage.getItem('filex.app.uploads')).toBeNull();
  });

  // A transfer the page did not finish is still staged on the server. Without this the bytes sit there until they
  // expire and the person is never told they could carry on.
  it('picks up an interrupted transfer after a reload, from the offset the server reports', async () => {
    const { files, uploads } = await setup();
    localStorage.setItem('filex.app.uploads', JSON.stringify([{ id: 'sess-7', parentId: 'demo', name: 'report.pdf', size: 1000 }]));
    vi.spyOn(repository, 'uploadSession').mockResolvedValue({ id: 'sess-7', offset: 400, size: 1000 });
    const resumed: unknown[] = [];
    vi.spyOn(repository, 'resumeUpload').mockImplementation(async (id, parentId, file) => {
      resumed.push({ id, parentId, name: file.name });
      return (await repository.listFolder('demo'))[0];
    });

    await uploads.restore();
    expect(uploads.items.map((i) => i.state)).toEqual(['interrupted']);
    expect(uploads.items[0].progress).toBe(40);

    // The bytes are gone with the page, so the same file has to be handed over again — and only that file.
    const wrong = await uploads.resume(uploads.items[0].id, new File(['x'], 'other.pdf'));
    expect(wrong).toBe(false);
    expect(resumed).toEqual([]);

    const right = new File(['x'.repeat(1000)], 'report.pdf');
    expect(await uploads.resume(uploads.items[0].id, right)).toBe(true);
    expect(resumed).toEqual([{ id: 'sess-7', parentId: 'demo', name: 'report.pdf' }]);
    expect(uploads.items[0].state).toBe('done');
    expect(localStorage.getItem('filex.app.uploads')).toBeNull();
    void files;
  });

  it('forgets a staged upload the server no longer knows', async () => {
    const { uploads } = await setup();
    localStorage.setItem('filex.app.uploads', JSON.stringify([{ id: 'gone', parentId: 'demo', name: 'a.txt', size: 10 }]));
    vi.spyOn(repository, 'uploadSession').mockResolvedValue(null);

    await uploads.restore();
    // No row offering to resume something that cannot be resumed, and no record of it either.
    expect(uploads.items).toEqual([]);
    expect(localStorage.getItem('filex.app.uploads')).toBeNull();
  });

  // A failure is not a cancellation: the server still holds what it accepted, and the next load offers to carry on.
  it('keeps the staged record after a failure', async () => {
    const { uploads } = await setup();
    vi.spyOn(repository, 'uploadFile').mockImplementation(async (_parentId, _file, options) => {
      options?.onSession?.('sess-9');
      throw new Error('storage offline');
    });
    await uploads.start([file('a.txt')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(uploads.items[0].state).toBe('failed');
    expect(JSON.parse(localStorage.getItem('filex.app.uploads') ?? '[]')).toEqual([
      { id: 'sess-9', parentId: 'demo', name: 'a.txt', size: 1 },
    ]);
  });

});
