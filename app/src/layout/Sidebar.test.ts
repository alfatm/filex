import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import Sidebar from './Sidebar.vue';

const Page = { template: '<div />' };
const ACTIVE = 'bg-primary-soft';

async function mountSidebar() {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/files/:path*', name: 'files', component: Page },
      { path: '/storage/:id', name: 'storage', component: Page },
      { path: '/connect', name: 'connect', component: Page },
      { path: '/api-keys', name: 'apiKeys', component: Page },
      { path: '/home', name: 'home', component: Page },
      { path: '/shared', name: 'shared', component: Page },
      { path: '/recent', name: 'recent', component: Page },
      { path: '/starred', name: 'starred', component: Page },
      { path: '/trash', name: 'trash', component: Page },
    ],
  });
  await router.push('/files');
  const files = useFilesStore();
  await files.bootstrap();
  const wrapper = mount(Sidebar, { attachTo: document.body, global: { plugins: [router, i18n] } });
  await nextTick();
  return { files, wrapper };
}

describe('Sidebar storages', () => {
  // The condition used to be the route name alone, so a second drive made every row light up at once.
  it('marks only the drive the listing is in', async () => {
    const { files, wrapper } = await mountSidebar();
    files.storages = [
      { id: 'main', name: 'main', rootId: 'main://', quota: { usedBytes: 0, totalBytes: 0 }, shared: false },
      { id: 'demo', name: 'demo', rootId: 'demo://', quota: { usedBytes: 0, totalBytes: 0 }, shared: false },
    ];
    await nextTick();

    const rows = wrapper.findAll('a').filter((a) => ['main', 'demo'].includes(a.text()));
    expect(rows).toHaveLength(2);
    const active = rows.filter((a) => a.classes().includes(ACTIVE)).map((a) => a.text());
    expect(active).toEqual([files.storage!.name]);
    wrapper.unmount();
  });

  it('marks no drive at all away from the folder view', async () => {
    const { wrapper } = await mountSidebar();
    await wrapper.vm.$router.push('/trash');
    await nextTick();
    const rows = wrapper.findAll('a').filter((a) => a.text() === 'demo' || a.text() === 'main');
    expect(rows.some((a) => a.classes().includes(ACTIVE))).toBe(false);
    wrapper.unmount();
  });
});
