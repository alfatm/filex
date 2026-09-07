import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import { useFilesStore } from './files';
import { useToastStore } from './toast';
import { useViewStore } from './view';

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath('');
  return files;
}

const names = (files: ReturnType<typeof useFilesStore>) => files.selected.map((n) => n.name);

describe('files store', () => {
  it('bootstraps the first storage and the user, then opens the root by path', async () => {
    const files = await setup();
    expect(files.storage?.id).toBe('demo');
    expect(files.user?.id).toBe('demo');
    expect(files.folder?.id).toBe('demo');
    expect(files.path).toEqual([]);
    expect(files.ordered).toHaveLength(16);
    await files.openPath('Design');
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
    await files.openPath('Nope');
    expect(files.error).toBe('notFound');
    expect(files.ordered).toEqual([]);
    expect(files.loading).toBe(false);
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
    expect(files.folder?.itemCount).toBe(15);
    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0].text).toBe('“Design” moved to trash');
    expect(toast.toasts[0].action?.label).toBe('Undo');

    toast.toasts[0].action!.run();
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(files.ordered.map((n) => n.name)).toContain('Design');
    expect(files.folder?.itemCount).toBe(16);
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
    await files.openPath('Design');
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
    const times = files.ordered.map((n) => Date.parse(n.modifiedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
