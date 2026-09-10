import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import { splitRoute } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import Breadcrumbs from './Breadcrumbs.vue';

const Page = { template: '<div />' };

const folder = (id: string, name: string): Node => ({ id, name, kind: 'folder', parentId: null, size: 0, ownerId: 'demo', shared: false, starred: false });

/** The bar over the folder at `path` ("<drive>/<folder>…"), opened the way the page opens it: from the route. */
async function mountBar(path: string) {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: Page }] });
  await router.push(`/files/${path}`);
  const files = useFilesStore();
  await files.bootstrap();
  const { drive, path: rel } = splitRoute(router.currentRoute.value.params.path);
  await files.openPath(drive, rel);
  const wrapper = mount(Breadcrumbs, { attachTo: document.body, global: { plugins: [router, i18n] } });
  await flushPromises();
  return { wrapper, router };
}

describe('the breadcrumb bar', () => {
  afterEach(() => vi.restoreAllMocks());

  // A drive root has a single crumb, and it is the open folder: as plain text it left the bar with nothing to click.
  it('re-reads the listing when the crumb of the open folder is clicked', async () => {
    const { wrapper } = await mountBar('demo');
    const listFolder = vi.spyOn(repository, 'listFolder');

    const current = wrapper.find('h1 button');
    expect(current.text()).toBe('demo');
    await current.trigger('click');
    await flushPromises();

    expect(listFolder).toHaveBeenCalledWith('demo', expect.anything());
  });

  // Four crumbs is one more than the bar keeps, so the second one goes behind the "…".
  it('folds the middle of a long chain behind a menu', async () => {
    const { wrapper } = await mountBar('demo');
    const files = useFilesStore();
    files.path = [folder('demo', 'demo'), folder('demo://A', 'A'), folder('demo://A/B', 'B')];
    files.folder = folder('demo://A/B/C', 'C');
    await nextTick();

    expect(wrapper.findAll('button').map((b) => b.attributes('aria-label') ?? b.text())).toEqual([
      'Home',
      'demo',
      'More folders',
      'B',
      'C',
      'Subfolders',
    ]);

    await wrapper.get('[aria-label="More folders"]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('A');
  });

  // The button that calls `edit` sits with the page's view controls, so the crumb chain ends at its own chevron.
  it('opens the address typed into the path box', async () => {
    const { wrapper, router } = await mountBar('demo/Design');

    await wrapper.vm.edit();
    await flushPromises();
    const box = wrapper.get('input');
    expect((box.element as HTMLInputElement).value).toBe('demo/Design');

    await box.setValue('demo/Photos');
    await box.trigger('keydown.enter');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/files/demo/Photos');
    expect(wrapper.find('input').exists()).toBe(false);
  });
});
