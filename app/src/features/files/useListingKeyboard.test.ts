import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useClipboardStore } from './clipboardStore';
import { useModalsStore } from './modalsStore';
import { useUndoStore } from './undoStore';
import { useListingKeyboard } from './useListingKeyboard';

/** The composable needs a component context (i18n, router); the host exposes it. */
async function setup() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }] });
  await router.push('/files');
  let keyboard!: ReturnType<typeof useListingKeyboard>;
  const Host = defineComponent({
    setup() {
      keyboard = useListingKeyboard();
      return () => h('div');
    },
  });
  mount(Host, { global: { plugins: [router, i18n] } });
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath(null, '');
  return { keyboard, files, modals: useModalsStore(), clipboard: useClipboardStore(), undo: useUndoStore(), router };
}

function key(key: string, target: Element = document.createElement('div'), extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  let prevented = false;
  return {
    key,
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
    target,
    preventDefault: () => (prevented = true),
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as KeyboardEvent;
}

describe('useListingKeyboard', () => {
  it('Delete opens the trash confirmation for the selection; F2 opens Rename for a single target', async () => {
    const { keyboard, files, modals } = await setup();
    files.select('design');
    files.select('code', { toggle: true });
    const del = key('Delete');
    keyboard.onKeydown(del);
    expect(del.defaultPrevented).toBe(true);
    expect(modals.active).toMatchObject({ kind: 'delete', variant: 'trash' });
    expect((modals.active as { nodes: { name: string }[] }).nodes.map((n) => n.name).sort()).toEqual(['Code', 'Design']);

    // Two selected: F2 is not consumed.
    modals.close();
    const f2 = key('F2');
    keyboard.onKeydown(f2);
    expect(f2.defaultPrevented).toBe(false);
    expect(modals.active).toBeNull();

    files.select('design');
    keyboard.onKeydown(key('F2'));
    expect(modals.active).toMatchObject({ kind: 'rename', node: { name: 'Design' } });
  });

  it('Enter opens the cursor folder through the router; keys inside interactive elements are left alone', async () => {
    const { keyboard, files, router } = await setup();
    files.handleKeydown(key('ArrowDown'), { open: () => {} });
    const enter = key('Enter');
    keyboard.onKeydown(enter);
    expect(enter.defaultPrevented).toBe(true);
    await router.isReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(router.currentRoute.value.params.path).toEqual([files.storage!.id, files.ordered[0].name]);

    const inButton = key('Delete', document.createElement('button'));
    keyboard.onKeydown(inButton);
    expect(inButton.defaultPrevented).toBe(false);
  });

  it('in the trash, Delete asks to delete forever and F2 does nothing', async () => {
    const { keyboard, files, modals } = await setup();
    await files.trash([files.ordered.find((n) => n.name === 'Archive')!]);
    await files.openListing('trash');
    files.select('archive');
    keyboard.onKeydown(key('F2'));
    expect(modals.active).toBeNull();
    keyboard.onKeydown(key('Delete'));
    expect(modals.active).toMatchObject({ kind: 'delete', variant: 'forever', nodes: [{ name: 'Archive' }] });
  });

  it('Ctrl+C fills the clipboard as a copy, Ctrl+V duplicates in place, and the originals stay put', async () => {
    const { keyboard, files, clipboard } = await setup();
    files.select('design');
    const copy = key('c', document.createElement('div'), { code: 'KeyC', ctrlKey: true } as Partial<KeyboardEvent>);
    keyboard.onKeydown(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(clipboard.mode).toBe('copy');
    // A copy leaves its rows alone; only a cut greys them.
    expect(clipboard.isCut('design')).toBe(false);

    keyboard.onKeydown(key('v', document.createElement('div'), { code: 'KeyV', ctrlKey: true } as Partial<KeyboardEvent>));
    await new Promise((r) => setTimeout(r, 0));
    const names = files.ordered.map((n) => n.name);
    expect(names).toContain('Design');
    expect(names).toContain('Design-copy');
  });

  it('Ctrl+Z takes back the last action and Ctrl+Shift+Z puts it back, one step deep', async () => {
    const { keyboard, files, undo } = await setup();
    const ctrlZ = (shiftKey = false) =>
      keyboard.onKeydown(key('z', document.createElement('div'), { code: 'KeyZ', ctrlKey: true, shiftKey } as Partial<KeyboardEvent>));
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const listed = () => files.ordered.map((n) => n.name);

    const design = files.ordered.find((n) => n.name === 'Design')!;
    await files.trash([design]);
    expect(listed()).not.toContain('Design');
    expect(undo.canUndo).toBe(true);
    expect(undo.canRedo).toBe(false);

    ctrlZ();
    await settle();
    expect(listed()).toContain('Design');
    // Undoing is not itself a new action: nothing is left to undo, and the step is now waiting to be redone.
    expect(undo.canUndo).toBe(false);
    expect(undo.canRedo).toBe(true);

    ctrlZ(true);
    await settle();
    expect(listed()).not.toContain('Design');
    expect(undo.canUndo).toBe(true);
    expect(undo.canRedo).toBe(false);

    // A new action drops the forward step: what was undone cannot be put back on top of something else.
    ctrlZ();
    await settle();
    await files.setStarred([files.ordered.find((n) => n.name === 'Code')!], true);
    expect(undo.canRedo).toBe(false);
  });

  it('Ctrl+A still selects everything, and Ctrl+R is left to the browser', async () => {
    const { keyboard, files } = await setup();
    keyboard.onKeydown(key('a', document.createElement('div'), { code: 'KeyA', ctrlKey: true } as Partial<KeyboardEvent>));
    expect(files.selected.length).toBe(files.ordered.length);

    const reload = key('r', document.createElement('div'), { code: 'KeyR', ctrlKey: true } as Partial<KeyboardEvent>);
    keyboard.onKeydown(reload);
    expect(reload.defaultPrevented).toBe(false);

    // The bare letter is the listing's own refresh.
    const refresh = key('r', document.createElement('div'), { code: 'KeyR' } as Partial<KeyboardEvent>);
    keyboard.onKeydown(refresh);
    expect(refresh.defaultPrevented).toBe(true);
  });
});
