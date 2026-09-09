import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import type { Node } from '@/data/types';
import { useOperationsStore } from '@/features/files/operationsStore';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import DetailsPanel from './DetailsPanel.vue';

const node: Node = { id: 'demo://Docs/brief.pdf', name: 'brief.pdf', kind: 'file', parentId: 'demo://Docs', size: 10, ownerId: 'u1', shared: false, starred: false };
const Page = { template: '<div />' };

async function mountPanel() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: Page }] });
  await router.push('/files');
  await useFilesStore().bootstrap();
  const wrapper = mount(DetailsPanel, {
    props: { node, path: [], people: [], user: null },
    attachTo: document.body,
    global: { plugins: [router, i18n] },
  });
  await flushPromises();
  return wrapper;
}

describe('the details panel share section', () => {
  afterEach(() => vi.restoreAllMocks());

  // "Not shared" beside a Create-link button is a guess, and acting on the guess mints a SECOND link for a node
  // that already had one.
  it('offers neither button when the link could not be read', async () => {
    vi.spyOn(repository, 'shareLink').mockRejectedValue(new Error('offline'));
    const wrapper = await mountPanel();

    expect(wrapper.text()).toContain('Could not read the link status');
    expect(wrapper.text()).not.toContain('Not shared');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Create link')).toBe(false);
    wrapper.unmount();
  });

  // The two calls went straight to the store, so a refusal reached nobody: no row, no message, the panel unchanged.
  it('puts a refused Create link in the operations tray', async () => {
    vi.spyOn(repository, 'shareLink').mockResolvedValue(null);
    vi.spyOn(repository, 'createShareLink').mockRejectedValue(new Error('not allowed to share'));
    const wrapper = await mountPanel();

    await wrapper.findAll('button').find((b) => b.text() === 'Create link')!.trigger('click');
    await flushPromises();

    const operations = useOperationsStore();
    expect(operations.items.map((o) => [o.state, o.error])).toEqual([['failed', 'not allowed to share']]);
    wrapper.unmount();
  });
});
