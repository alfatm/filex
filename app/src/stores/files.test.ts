import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { resetMock } from '@/data/mock';
import { useFilesStore } from './files';
import { useToastStore } from './toast';
import { useViewStore } from './view';
import { useUndoStore } from '@/features/files/undoStore';
import { useOperationsStore } from '@/features/files/operationsStore';
import { NOT_FOUND, OPERATION_PENDING } from '@/data/repository';

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath(null, '');
  return files;
}

const names = (files: ReturnType<typeof useFilesStore>) => files.selected.map((n) => n.name);

describe('an unreachable server', () => {
  // Without this the rejection went nowhere and the folder page drew "Drop files here" — which reads as "your
  // drive is empty" when the truth is that nobody answered.
  it('lands in the error state rather than looking like an empty drive', async () => {
    resetMock();
    setActivePinia(createPinia());
    const spy = vi.spyOn(repository, 'listStorages').mockRejectedValue(new Error('offline'));
    const files = useFilesStore();
    await files.bootstrap();
    spy.mockRestore();

    expect(files.ready).toBe(true);
    expect(files.error).toBe('load');
    expect(files.storages).toEqual([]);

    // Try again, with the server back: the same button recovers the whole start-up, not just the listing.
    await files.retry();
    expect(files.error).toBeNull();
    expect(files.storages.length).toBeGreaterThan(0);
  });

  // A folder that could not be REACHED used to be reported as one that had been renamed, moved or deleted —
  // a sentence about the person's files that a 500 or a dropped connection gives nobody the right to say.
  it('says the listing failed, not that the folder is gone, when resolving the address throws', async () => {
    const files = await setup();
    const spy = vi.spyOn(repository, 'resolvePath').mockRejectedValue(new Error('500: boom'));
    await files.openPath(null, 'Design');
    spy.mockRestore();

    expect(files.error).toBe('load');
    expect(files.ordered).toEqual([]);
    expect(files.loading).toBe(false);
  });

  // …and the other half of the same rule: an address that really names nothing still says so.
  it('keeps saying not found when the repository reports the address as missing', async () => {
    const files = await setup();
    const spy = vi.spyOn(repository, 'resolvePath').mockRejectedValue(new Error(NOT_FOUND));
    await files.openPath(null, 'Nope');
    spy.mockRestore();

    expect(files.error).toBe('notFound');
  });
});

describe('the home drive', () => {
  // `main` holds the users' own files and is "My files" in the sidebar, so it is neither listed beside the extra
  // mounts nor allowed to depend on the server's order for being the drive `/files` opens.
  it('stays off the drive list and is the one an address without a drive opens', async () => {
    const files = await setup();
    const demo = files.storages[0];
    files.storages = [{ ...demo, id: 'main', name: 'main', rootId: 'main://' }, demo];
    await nextTick();

    expect(files.listedStorages.map((s) => s.id)).toEqual([demo.id]);
    await files.openPath(null, '');
    expect(files.storage?.id).toBe('main');
  });
});

describe('the open drive', () => {
  it('follows the drive the address names, and defaults to the first without one', async () => {
    const files = await setup();
    const first = files.storages[0];
    expect(files.storage?.id).toBe(first.id);

    // A second drive, so "the open one" stops being the only one.
    files.storages = [...files.storages, { ...first, id: 'other', name: 'other', rootId: 'other://' }];
    await files.openPath('other', '');
    expect(files.storage?.id).toBe('other');

    // No drive in the address — `/files`, and the flat listings — means the first one, not the last one opened.
    await files.openPath(null, '');
    expect(files.storage?.id).toBe(first.id);
  });

  // Silently opening somebody else's drive under the address you typed would be the worse answer.
  it('says not found for a drive nobody has heard of, and stays where it was', async () => {
    const files = await setup();
    const here = files.storage?.id;
    await files.openPath('nope', 'Design');
    expect(files.error).toBe('notFound');
    expect(files.storage?.id).toBe(here);
    expect(files.items).toEqual([]);
  });
});

describe('files store', () => {
  it('bootstraps the first storage and the user, then opens the root by path', async () => {
    const files = await setup();
    expect(files.storage?.id).toBe('demo');
    expect(files.user?.id).toBe('demo');
    expect(files.folder?.id).toBe('demo');
    expect(files.path).toEqual([]);
    expect(files.ordered).toHaveLength(17);
    await files.openPath(null, 'Design');
    expect(files.folder?.name).toBe('Design');
    expect(files.path.map((n) => n.id)).toEqual(['demo']);
    // Default sort is modified desc: the children are dated hourly below the folder's date, in tree order.
    expect(files.ordered.map((n) => n.name)).toEqual([
      'Brand Guidelines.pdf',
      'animation.gif',
      'dashboard.png',
      'file-browser.jpg',
      'illustration.webp',
      'logo.svg',
      'source-design.psd',
      'wireframe.png',
    ]);
    // A path that resolves to nothing is a page state, not a rejection: the page shows it and offers a retry.
    await files.openPath(null, 'Nope');
    expect(files.error).toBe('notFound');
    expect(files.ordered).toEqual([]);
    expect(files.loading).toBe(false);
  });

  it('the name box narrows the open folder case-insensitively and is cleared by the next navigation', async () => {
    const files = await setup();
    await files.openPath(null, 'Design');
    files.nameFilter = '  .PNG ';
    expect(files.filtered).toBe(true);
    expect(files.ordered.map((n) => n.name)).toEqual(['dashboard.png', 'wireframe.png']);
    await files.openPath(null, '');
    expect(files.nameFilter).toBe('');
    expect(files.filtered).toBe(false);
    files.nameFilter = 'nope';
    files.clearFilter();
    expect(files.nameFilter).toBe('');
  });

  it('orders folders before files and sorts modified dates as instants', async () => {
    const files = await setup();
    const view = useViewStore();
    view.sortKey = 'modified';
    view.sortDir = 'desc';
    expect(files.folders[0]?.name).toBe('Code');
    expect(files.files[0]?.name).toBe('README.md');
    expect(files.ordered.slice(0, 8).every((n) => n.kind === 'folder')).toBe(true);
    view.sortDir = 'asc';
    expect(files.folders[0]?.name).toBe('Shared');
    expect(files.files[0]?.name).toBe('demo.mp4');
  });

  it('range and toggle selection follow the visual order across the folder/file boundary', async () => {
    const files = await setup();
    const view = useViewStore();
    view.sortKey = 'name';
    view.sortDir = 'asc';
    files.select('shared');
    files.select('app-ts', { range: true });
    expect(names(files)).toEqual(['Shared', 'app.ts']);
    files.select('beach-png', { toggle: true });
    expect(names(files)).toEqual(['Shared', 'app.ts', 'beach.png']);
    files.toggle('shared');
    expect(names(files)).toEqual(['app.ts', 'beach.png']);
    expect(files.allState).toBe('some');
    files.selectAll();
    expect(files.allState).toBe('all');
    files.clearSelection();
    expect(files.allState).toBe('none');
  });

  it('focuses the single selection and loads its people; opening a folder clears the selection', async () => {
    const files = await setup();
    expect(files.focusNode?.id).toBe('demo');
    files.select('design');
    expect(files.focusNode?.id).toBe('design');
    await nextTick();
    await nextTick();
    expect(files.people.map((p) => p.id)).toEqual(['demo']);
    await files.open('design');
    expect(files.selected).toEqual([]);
    expect(files.focusedId).toBeNull();
  });

  it('moves to trash with an Undo toast; undo restores and the listing refreshes', async () => {
    const files = await setup();
    const toast = useToastStore();
    const design = files.ordered.find((n) => n.name === 'Design')!;
    files.select(design.id);
    await files.trash([design]);
    expect(files.ordered.map((n) => n.name)).not.toContain('Design');
    expect(files.selected).toEqual([]);
    expect(files.folder?.itemCount).toBe(16);
    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0].text).toBe('“Design” moved to trash');
    expect(toast.toasts[0].action?.label).toBe('Undo');

    toast.toasts[0].action!.run();
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(files.ordered.map((n) => n.name)).toContain('Design');
    expect(files.folder?.itemCount).toBe(17);
    expect(files.revision).toBe(2);
    // The restore owns its toast (the menu, the selection bar and Undo all go through it).
    expect(toast.toasts.map((t) => t.text)).toEqual(['“Design” moved to trash', '“Design” restored']);

    await files.openListing('trash');
    expect(files.listing).toEqual({ kind: 'trash' });
    expect(files.folder).toBeNull();
    expect(files.ordered).toEqual([]);
  });

  it('deleteForever / emptyTrash dismiss pending Undo toasts and announce themselves', async () => {
    const files = await setup();
    const toast = useToastStore();
    const design = files.ordered.find((n) => n.name === 'Design')!;
    await files.trash([design]);
    expect(toast.toasts[0].action).toBeDefined();
    await files.deleteForever([design]);
    expect(toast.toasts.map((t) => t.text)).toEqual(['“Design” deleted forever']);

    await files.trash([files.ordered.find((n) => n.name === 'Code')!]);
    await files.emptyTrash();
    expect(toast.toasts.every((t) => !t.action)).toBe(true);
    expect(toast.toasts.at(-1)?.text).toBe('Trash emptied');
  });

  it('a queued job the server has not finished says so in the tray, refreshes, and arms no Undo', async () => {
    const files = await setup();
    const toast = useToastStore();
    const undo = useUndoStore();
    const operations = useOperationsStore();
    const design = files.ordered.find((n) => n.name === 'Design')!;
    // What the HTTP repository raises when it stops waiting on the ops queue: taken, running, not finished.
    const spy = vi.spyOn(repository, 'moveToTrash').mockRejectedValue(new Error(OPERATION_PENDING));
    try {
      await files.trash([design]);
    } finally {
      spy.mockRestore();
    }

    expect(operations.shown.map((o) => [o.label, o.state])).toEqual([['Moving “Design” to trash', 'pending']]);
    // No toast and no Undo: half a move is not a step that can be taken back, and the row is not a success.
    expect(toast.toasts).toEqual([]);
    expect(undo.canUndo).toBe(false);
    // The listing was read again anyway — the folder is changing under the user right now.
    expect(files.revision).toBe(1);
  });

  it('a mutation that fails is a row in the tray carrying what the server said, not silence', async () => {
    const files = await setup();
    const operations = useOperationsStore();
    const design = files.ordered.find((n) => n.name === 'Design')!;
    const spy = vi.spyOn(repository, 'moveToTrash').mockRejectedValue(new Error('storage is read-only'));
    try {
      // It resolves: every caller of this was an unawaited click handler, so a rejection reached nobody at all.
      await files.trash([design]);
    } finally {
      spy.mockRestore();
    }

    expect(operations.shown.map((o) => [o.state, o.error])).toEqual([['failed', 'storage is read-only']]);
    expect(files.ordered.map((n) => n.name)).toContain('Design');

    operations.dismiss(operations.shown[0].id);
    expect(operations.open).toBe(false);
  });

  it('an operation that simply works leaves no trace in the tray', async () => {
    const files = await setup();
    const operations = useOperationsStore();
    await files.trash([files.ordered.find((n) => n.name === 'Design')!]);
    expect(operations.items).toEqual([]);
  });

  it('trash listing sorts its date column by deletedAt', async () => {
    const files = await setup();
    const view = useViewStore();
    view.sortKey = 'modified';
    view.sortDir = 'desc';
    // README.md is the newest file by modifiedAt, but Archive goes to the trash last.
    await repository.moveToTrash(['readme-md']);
    await new Promise((r) => setTimeout(r, 5));
    await repository.moveToTrash(['archive']);
    await files.openListing('trash');
    expect(files.ordered.map((n) => n.name)).toEqual(['Archive', 'README.md']);
    view.sortDir = 'asc';
    expect(files.ordered.map((n) => n.name)).toEqual(['Archive', 'README.md']);
    expect(files.files.map((n) => n.name)).toEqual(['README.md']);
  });

  it('leave() drops the folder so New / uploads target the root, and stale loads never overwrite the newest one', async () => {
    const files = await setup();
    await files.openPath(null, 'Design');
    files.select('design');
    files.leave();
    expect(files.folder).toBeNull();
    expect(files.listing).toBeNull();
    expect(files.items).toEqual([]);
    expect(files.selected).toEqual([]);
    expect(files.targetFolderId).toBe('demo');
    const created = await files.createFolder('Reports');
    expect(created.parentId).toBe('demo');
    // Off the folder view nothing is listed or selected, but the mutation counter still advances.
    expect(files.items).toEqual([]);
    expect(files.revision).toBe(1);

    // Two overlapping loads: the earlier one resolves last but must not win.
    const slow = files.open('design');
    const fast = files.openListing('starred');
    await Promise.all([slow, fast]);
    expect(files.listing).toEqual({ kind: 'starred' });
    expect(files.folder).toBeNull();
  });

  it('recent listing is pinned newest-first regardless of the view sort', async () => {
    const files = await setup();
    const view = useViewStore();
    view.sortKey = 'name';
    view.sortDir = 'asc';
    await files.openListing('recent');
    expect(files.ordered[0]?.name).toBe('Q3 report.pdf');
    const times = files.ordered.map((n) => Date.parse(n.modifiedAt ?? ''));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('a helper request that fails', () => {
  // The People chip's options shared the listing's `try`, so a refusal there threw away a listing that HAD
  // arrived and put "Could not load this listing" over it.
  it('leaves the listing standing when the People chip cannot be filled', async () => {
    const files = await setup();
    const spy = vi.spyOn(repository, 'listFilterPeople').mockRejectedValue(new Error('offline'));
    await files.openPath(null, 'Design');
    spy.mockRestore();

    expect(files.error).toBeNull();
    expect(files.items.length).toBeGreaterThan(0);
  });

  // Same request, same reasoning, at start-up: it sat in the `Promise.all` with the drives and the account, so a
  // refused chip started the whole app in the "could not load" state.
  it('still starts the app when the People chip cannot be filled at bootstrap', async () => {
    resetMock();
    setActivePinia(createPinia());
    const spy = vi.spyOn(repository, 'listFilterPeople').mockRejectedValue(new Error('offline'));
    const files = useFilesStore();
    await files.bootstrap();
    spy.mockRestore();

    expect(files.error).toBeNull();
    expect(files.ready).toBe(true);
    expect(files.storages.length).toBeGreaterThan(0);
    expect(files.filterPeople).toEqual([]);
  });

  // Otherwise the details panel keeps the PREVIOUS node's people and location under the new node's name.
  it('forgets the previous node when the focused one cannot be described', async () => {
    const files = await setup();
    files.select('design');
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
    expect(files.focusPath.length).toBeGreaterThan(0);

    const people = vi.spyOn(repository, 'listPeople').mockRejectedValue(new Error('forbidden'));
    const path = vi.spyOn(repository, 'getPath').mockRejectedValue(new Error('forbidden'));
    files.select('code');
    await nextTick();
    await vi.waitFor(() => expect(files.focusPath).toEqual([]));
    people.mockRestore();
    path.mockRestore();

    expect(files.people).toEqual([]);
    expect(files.canManagePeople).toBe(false);
  });
});

describe('a navigation that is overtaken', () => {
  // `resolvePath` is a request of its own over HTTP: the folder that was clicked first can answer last, and it
  // used to open itself over the listing the person had already moved on to.
  it('drops a folder that resolves after a newer listing is open', async () => {
    const files = await setup();
    const design = files.ordered.find((n) => n.name === 'Design')!;
    let land!: (node: Node) => void;
    const spy = vi.spyOn(repository, 'resolvePath').mockReturnValue(new Promise<Node>((resolve) => (land = resolve)));
    const slow = files.openPath(null, 'Design');
    await files.openListing('starred');
    land(design);
    await slow;
    spy.mockRestore();

    expect(files.listing).toEqual({ kind: 'starred' });
    expect(files.folder).toBeNull();
    expect(files.error).toBeNull();
  });

  // The same for the refusal: a late "no such folder" must not put not-found over the listing on screen.
  it('drops an address that fails to resolve after a newer listing is open', async () => {
    const files = await setup();
    let refuse!: (error: Error) => void;
    const spy = vi.spyOn(repository, 'resolvePath').mockReturnValue(new Promise<Node>((_, reject) => (refuse = reject)));
    const slow = files.openPath(null, 'Nope');
    await files.openListing('starred');
    refuse(new Error('path not found'));
    await slow;
    spy.mockRestore();

    expect(files.error).toBeNull();
    expect(files.listing).toEqual({ kind: 'starred' });
  });
});
