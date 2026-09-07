import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useModalsStore } from './modalsStore';
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
  await files.openPath('');
  return { keyboard, files, modals: useModalsStore(), router };
}

function key(key: string, target: Element = document.createElement('div')): KeyboardEvent {
  let prevented = false;
  return {
    key,
    code: '',
    ctrlKey: false,
    metaKey: false,
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
    expect(router.currentRoute.value.params.path).toEqual([files.ordered[0].name]);

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
});
