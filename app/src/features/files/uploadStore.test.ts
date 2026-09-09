import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { MOCK_UPLOAD_MS, resetMock } from '@/data/mock';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import { useSettingsStore, type ConflictBehavior } from '@/features/settings/settingsStore';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { useModalsStore } from './modalsStore';
import { useOperationsStore } from './operationsStore';
import { MAX_PARALLEL_UPLOADS, useUploadStore } from './uploadStore';

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath(null, '');
  return { files, uploads: useUploadStore(), settings: useSettingsStore(), toast: useToastStore() };
}

/** A name that is already in the demo root, which is what every conflict test here is about. */
const TAKEN = 'README.md';

function setRule(settings: ReturnType<typeof useSettingsStore>, rule: ConflictBehavior) {
  settings.apply({ ...settings.settings, conflictBehavior: rule });
}

/** The shape a drop hands over: `items` is the only place a FOLDER can be told from a file. */
function dropOf(entries: { file?: File; folder?: string }[]): DataTransfer {
  return {
    files: entries.filter((e) => e.file).map((e) => e.file),
    items: entries.map((e) => ({
      kind: 'file',
      getAsFile: () => e.file ?? null,
      webkitGetAsEntry: () => (e.folder ? { isDirectory: true, name: e.folder } : { isDirectory: false, name: e.file?.name }),
    })),
  } as unknown as DataTransfer;
}

/** A file node the mock never produces for an upload: previews need an asset URL and a type. */
const IMAGE: Node = {
  id: 'demo/shot.png',
  name: 'shot.png',
  kind: 'file',
  parentId: 'demo',
  size: 10,
  ownerId: 'demo',
  shared: false,
  starred: false,
  fileType: 'image',
  assetUrl: '/app/demo-assets/shot.png',
};

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
    await files.openPath(null, '');
    await uploads.start([inFolder('Trip/raw/d.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(files.ordered.filter((n) => n.name === 'Trip')).toHaveLength(1);
    await files.open(raw.id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  // What the tree build costs. The old walk asked for a full listing of the parent before every folder, to decide
  // one boolean, and did the whole thing one file at a time.
  it('builds an uploaded tree a level at a time, without listing a folder to find out a name is free', async () => {
    const { uploads } = await setup();
    const created = vi.spyOn(repository, 'createFolder');
    const listed = vi.spyOn(repository, 'listFolder');

    await uploads.start([inFolder('Trip/a.txt'), inFolder('Trip/raw/b.txt'), inFolder('Trip/raw/c.txt')]);

    // Two folders, two creates — three files sharing them cost nothing extra.
    expect(created.mock.calls.map((c) => c[1])).toEqual(['Trip', 'raw']);
    // One listing, and it is the refresh that puts the new tree on screen. Neither folder was listed for to find
    // out its name was free: a folder being uploaded is usually new, so the collision is read as the answer
    // instead of being asked about in advance. The old walk listed once per folder — three in total here.
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it('reads a name collision as “it is already there” and pays for the listing only then', async () => {
    const { files, uploads } = await setup();
    await uploads.start([inFolder('Trip/a.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    await files.openPath(null, '');

    const listed = vi.spyOn(repository, 'listFolder');
    await uploads.start([inFolder('Trip/b.txt')]);
    // Counted while the tree build is the only thing that has happened: three — the collision, which is the one
    // time a listing earns its cost; the refresh that shows the tree; and the names already in the folder the file
    // is going into, which is what the name-conflict rule is decided against. A folder this drop CREATED is known
    // to be empty and is not listed for that (see the level-at-a-time test above, which still pays only one).
    expect(listed).toHaveBeenCalledTimes(3);
    listed.mockRestore(); // everything below transfers or navigates, and both list

    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    // Reused, not duplicated, and the second file landed in it.
    const trip = files.ordered.filter((n) => n.name === 'Trip');
    expect(trip).toHaveLength(1);
    await files.open(trip[0].id);
    expect(files.ordered.map((n) => n.name).sort()).toEqual(['a.txt', 'b.txt']);
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

  // "Could not ask" is not "the session is gone": the record used to be erased on any error at startup, while the
  // server still held the bytes and the quota reserved against them, with nothing left to release them.
  it('keeps the staged record when the session could not be asked about', async () => {
    const { uploads } = await setup();
    const record = [{ id: 'sess-8', parentId: 'demo', name: 'a.txt', size: 10 }];
    localStorage.setItem('filex.app.uploads', JSON.stringify(record));
    vi.spyOn(repository, 'uploadSession').mockRejectedValue(new Error('offline'));

    await uploads.restore();
    // No row: the offset is unknown, so there is nothing to draw a resume button from — but the record stays.
    expect(uploads.items).toEqual([]);
    expect(JSON.parse(localStorage.getItem('filex.app.uploads') ?? '[]')).toEqual(record);
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

  // Three callers `void uploads.start(…)`, so a rejection reached nobody: a tree that could not be built produced
  // no row in the upload tray (there is none yet) and no message either.
  it('puts a tree build that failed in the operations tray instead of nowhere', async () => {
    const { uploads } = await setup();
    const operations = useOperationsStore();
    vi.spyOn(repository, 'createFolder').mockRejectedValue(new Error('storage offline'));

    await uploads.start([inFolder('Trip/a.txt')]);
    expect(uploads.items).toEqual([]);
    expect(operations.items.map((o) => [o.state, o.error, o.visible])).toEqual([['failed', 'storage offline', true]]);
  });

  // ⚠ Every transfer in flight is a staged session on the server, with quota reserved against it and a record in
  // localStorage. A drop of five hundred files used to open five hundred of them at the same instant.
  it('keeps at most a poolful of transfers in flight', async () => {
    const { uploads } = await setup();
    let live = 0;
    let peak = 0;
    vi.spyOn(repository, 'uploadFile').mockImplementation(async (_parentId, file) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 10));
      live--;
      return { ...IMAGE, id: `demo/${file.name}`, name: file.name };
    });

    await uploads.start(Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`)));
    // Every row exists from the start — the tray counts the whole batch — but only a poolful is being sent.
    expect(uploads.items).toHaveLength(12);
    expect(uploads.items.filter((i) => i.state === 'running')).toHaveLength(MAX_PARALLEL_UPLOADS);

    await vi.advanceTimersByTimeAsync(500);
    expect(peak).toBe(MAX_PARALLEL_UPLOADS);
    expect(uploads.doneCount).toBe(12);
  });

  // One re-read for the batch. Through `mutate` it was one per file: N listings of the folder, and twice as many
  // requests again from the details panel watching the focused node behind them.
  it('re-reads the listing once for the whole batch, not once per file', async () => {
    const { uploads } = await setup();
    const listed = vi.spyOn(repository, 'listFolder');
    await uploads.start([file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS * 5);
    expect(uploads.doneCount).toBe(4);
    expect(listed).toHaveBeenCalledTimes(1);
  });

  // A folder dragged out of the OS file manager arrives with no bytes and no relative path, and used to go to the
  // server as an ordinary zero-length file named after the folder.
  it('leaves a dropped folder out of the upload and says how to send one', async () => {
    const { files, uploads, toast } = await setup();
    await uploads.start(dropOf([{ file: file('a.txt') }, { folder: 'Trip' }]));
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS * 2);

    expect(uploads.items.map((i) => i.name)).toEqual(['a.txt']);
    expect(files.ordered.map((n) => n.name)).not.toContain('Trip');
    expect(toast.toasts.map((t) => t.text).join(' ')).toContain('Upload folder');
  });

  it('uploads into the default folder when nothing else names one', async () => {
    const { files, uploads, settings } = await setup();
    settings.apply({ ...settings.settings, defaultUploadFolder: 'design' });
    files.leave(); // Home and Search leave no folder behind; this is where the setting answers

    await uploads.start([file('a.txt')]);
    expect(uploads.items[0].parentId).toBe('design');
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    await files.open('design');
    expect(files.ordered.map((n) => n.name)).toContain('a.txt');
  });

  // ⚠ A node id here IS a path, so the saved folder stops existing the moment somebody renames it.
  it('falls back to the drive root when the default upload folder is gone, and says so', async () => {
    const { files, uploads, settings, toast } = await setup();
    settings.apply({ ...settings.settings, defaultUploadFolder: 'demo/renamed-away' });
    const root = files.storage!.rootId;
    files.leave();

    await uploads.start([file('a.txt')]);
    expect(uploads.items[0].parentId).toBe(root);
    expect(toast.toasts.map((t) => t.text).join(' ')).toContain('default upload folder is gone');
  });

  it('opens the preview of a file it has just uploaded, and only for one file at a time', async () => {
    const { uploads, settings } = await setup();
    const modals = useModalsStore();
    vi.spyOn(repository, 'uploadFile').mockResolvedValue(IMAGE);

    await uploads.start([file('shot.png')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(modals.active).toMatchObject({ kind: 'preview', nodes: [{ id: IMAGE.id }] });

    // A preview thrown over a folder drop would be in the way of the thing it interrupts.
    modals.close();
    await uploads.start([file('a.png'), file('b.png')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(modals.active).toBeNull();

    // And off means off.
    settings.apply({ ...settings.settings, autoOpenPreview: false });
    await uploads.start([file('c.png')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(modals.active).toBeNull();
  });

  // What the server does with a name that is taken is REPLACE — a staged commit overwrites and keeps the old bytes
  // as a version. The other rules are decided here, before any bytes are sent.
  it('skips a file whose name is taken when that is the rule', async () => {
    const { uploads, settings } = await setup();
    setRule(settings, 'skip');
    const sent = vi.spyOn(repository, 'uploadFile');

    await uploads.start([file(TAKEN), file('fresh.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS * 2);
    expect(uploads.items.map((i) => [i.name, i.state])).toEqual([[TAKEN, 'skipped'], ['fresh.txt', 'done']]);
    expect(sent.mock.calls.map((c) => c[1].name)).toEqual(['fresh.txt']);
  });

  it('lands a second copy beside the first when that is the rule', async () => {
    const { files, uploads, settings } = await setup();
    setRule(settings, 'keepBoth');
    const sent = vi.spyOn(repository, 'uploadFile');

    await uploads.start([file(TAKEN)]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    // The shape a paste already uses, so the two ways of ending up with a second copy read the same.
    expect(sent.mock.calls.map((c) => c[1].name)).toEqual(['README-copy.md']);
    expect(uploads.items[0].name).toBe('README-copy.md');
    expect(files.ordered.filter((n) => n.name === TAKEN)).toHaveLength(1);
  });

  it('sends the file under its own name, and asks for no listing at all, when the rule is replace', async () => {
    const { uploads, settings } = await setup();
    setRule(settings, 'replace');
    const listed = vi.spyOn(repository, 'listFolder');
    const sent = vi.spyOn(repository, 'uploadFile');

    await uploads.start([file(TAKEN)]);
    // Replacing is the server's own behaviour for a name that is taken, so nothing has to be asked in advance.
    expect(listed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(sent.mock.calls.map((c) => c[1].name)).toEqual([TAKEN]);
  });

  it('asks in the tray, and the answer decides — while the rest of the batch carries on', async () => {
    const { uploads, settings } = await setup();
    setRule(settings, 'ask');
    const sent = vi.spyOn(repository, 'uploadFile');

    await uploads.start([file(TAKEN), file('fresh.txt')]);
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    // The question holds no slot in the pool: the file with a free name is already there.
    expect(uploads.items.map((i) => i.state)).toEqual(['conflict', 'done']);
    expect(sent.mock.calls.map((c) => c[1].name)).toEqual(['fresh.txt']);

    uploads.decide(uploads.items[0].id, 'keepBoth');
    await vi.advanceTimersByTimeAsync(MOCK_UPLOAD_MS);
    expect(uploads.items[0].state).toBe('done');
    expect(sent.mock.calls.map((c) => c[1].name)).toEqual(['fresh.txt', 'README-copy.md']);
  });
});
