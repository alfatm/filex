import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noQuota, type Node } from '@/data/types';
import { useModalsStore } from '@/features/files/modalsStore';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AnswerText from './AnswerText.vue';

const spec: Node = { id: 'main://Docs/spec.pdf', name: 'spec.pdf', kind: 'file', parentId: 'main://Docs', size: 10, ownerId: 'me', shared: false, starred: false };

vi.mock('@/data', () => ({
  repository: {
    async resolvePath(_storage: string, path: string) {
      if (path !== 'Docs') throw new Error('path not found');
      return { id: 'main://Docs', name: 'Docs', kind: 'folder', parentId: 'main://', size: 0, ownerId: 'me', shared: false, starred: false };
    },
    async listFolder() {
      return { nodes: [spec], total: 1 };
    },
  },
}));

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }] });

async function setup(text: string) {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const files = useFilesStore();
  files.storages = [{ id: 'main', name: 'main', rootId: 'main://', quota: noQuota(), shared: false, viaGroups: [] }];
  await router.push('/files');
  const wrapper = mount(AnswerText, { props: { text }, global: { plugins: [router, i18n] } });
  return wrapper;
}

beforeEach(() => setActivePinia(createPinia()));

describe('AnswerText', () => {
  it('draws Markdown as elements', async () => {
    const wrapper = await setup('## Found two\n\n- **one**\n- `two.txt`\n\n```\nraw\n```');
    expect(wrapper.find('strong').text()).toBe('one');
    expect(wrapper.findAll('li')).toHaveLength(2);
    expect(wrapper.find('code').text()).toBe('two.txt');
    expect(wrapper.find('pre').text()).toBe('raw');
  });

  // ⚠ The answer is shaped by files other people wrote: it is never HTML.
  it('shows markup the model wrote as text', async () => {
    const wrapper = await setup('<img src=x onerror="alert(1)">');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">');
  });

  it('opens a file the answer named', async () => {
    const wrapper = await setup('It is in main://Docs/spec.pdf.');
    const link = wrapper.get('button');
    expect(link.text()).toBe('main://Docs/spec.pdf');
    await link.trigger('click');
    await flushPromises();
    expect(useModalsStore().active).toEqual({ kind: 'preview', nodes: [spec], index: 0 });
  });

  it('navigates to a folder the answer named', async () => {
    const wrapper = await setup('Look in main://Docs');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    // `main://Docs` in the answer becomes `/files/main/Docs` — the address the span named, drive and all.
    expect(router.currentRoute.value.path).toBe('/files/main/Docs');
  });

  // One drive is all the app can navigate today; a link that cannot lead anywhere is not a link.
  it('leaves an address on another drive as plain text', async () => {
    const wrapper = await setup('Try other://Docs/spec.pdf');
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('code').text()).toBe('other://Docs/spec.pdf');
  });
});
