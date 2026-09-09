import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useModalsStore } from './modalsStore';
import { useFileActions } from './useFileActions';

/** The composable needs a component context (i18n, router); the host exposes it. */
async function setup() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }] });
  await router.push('/files');
  let actions!: ReturnType<typeof useFileActions>;
  const Host = defineComponent({
    setup() {
      actions = useFileActions();
      return () => h('div');
    },
  });
  mount(Host, { global: { plugins: [router, i18n] } });
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath(null, '');
  return { actions, files, modals: useModalsStore(), router };
}

const byName = (files: ReturnType<typeof useFilesStore>, name: string) => files.ordered.find((n) => n.name === name)!;

describe('useFileActions', () => {
  it('acts on the whole selection when the target row is part of a multi-selection', async () => {
    const { actions, files, modals } = await setup();
    files.select('design');
    files.select('code', { toggle: true });
    await actions.run('moveToTrash', byName(files, 'Design'));
    expect(modals.active).toMatchObject({ kind: 'delete', variant: 'trash' });
    expect((modals.active as { nodes: { name: string }[] }).nodes.map((n) => n.name).sort()).toEqual(['Code', 'Design']);

    await actions.run('addToStarred', byName(files, 'Code'));
    expect(files.ordered.filter((n) => n.starred).map((n) => n.name).sort()).toEqual(['Code', 'Design', 'Photos', 'UI Design.fig', 'mountains.jpg']);
  });

  it('acts on the target alone when it is outside the selection or the selection is single', async () => {
    const { actions, files, modals } = await setup();
    files.select('design');
    files.select('code', { toggle: true });
    await actions.run('moveTo', byName(files, 'Archive'));
    expect((modals.active as { nodes: { name: string }[] }).nodes.map((n) => n.name)).toEqual(['Archive']);

    files.select('photos');
    await actions.run('moveToTrash', byName(files, 'Photos'));
    expect((modals.active as { nodes: { name: string }[] }).nodes.map((n) => n.name)).toEqual(['Photos']);
  });

  it('share and rename always target the single node; open navigates folders through the router', async () => {
    const { actions, files, modals, router } = await setup();
    files.select('design');
    files.select('code', { toggle: true });
    await actions.run('rename', byName(files, 'Design'));
    expect(modals.active).toMatchObject({ kind: 'rename', node: { name: 'Design' } });
    await actions.run('share', byName(files, 'Code'));
    expect(modals.active).toMatchObject({ kind: 'share', node: { name: 'Code' } });

    await actions.run('open', byName(files, 'Design'));
    // The drive leads the address now: `/files/demo/Design` is `demo://Design`.
    expect(router.currentRoute.value.params.path).toEqual(['demo', 'Design']);
  });

  it('open / preview on a file opens the preview over the listing files in their sort order', async () => {
    const { actions, files, modals } = await setup();
    await actions.run('open', byName(files, 'app.ts'));
    const active = modals.active as { kind: string; nodes: { name: string }[]; index: number };
    expect(active.kind).toBe('preview');
    // Default sort is last modified, newest first; folders are not part of the walk.
    expect(active.nodes.map((n) => n.name)).toEqual(files.files.map((n) => n.name));
    expect(active.nodes.map((n) => n.name).slice(0, 3)).toEqual(['README.md', 'Mechanical UI KIT 1.0 (Community).fig', 'mountains.jpg']);
    expect(active.index).toBe(3);

    // Explicit siblings (search results) replace the listing; a node outside them previews alone.
    await actions.run('preview', byName(files, 'data.csv'));
    expect((modals.active as typeof active).nodes.map((n) => n.name)).toEqual(files.files.map((n) => n.name));
    actions.preview(byName(files, 'data.csv'), [byName(files, 'README.md')]);
    expect((modals.active as typeof active).nodes.map((n) => n.name)).toEqual(['data.csv']);
  });
});
