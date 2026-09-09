import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import HomePage from './HomePage.vue';

const Page = { template: '<div />' };

async function mountHome() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: Page }] });
  await router.push('/files');
  await useFilesStore().bootstrap();
  const wrapper = mount(HomePage, { attachTo: document.body, global: { plugins: [router, i18n] } });
  await flushPromises();
  return wrapper;
}

describe('HomePage', () => {
  afterEach(() => vi.restoreAllMocks());

  // "No recent files yet" is a sentence about an ACCOUNT. Drawing it because nobody answered says something untrue,
  // which is the distinction `files.bootstrap` already makes for the listing.
  it('says the lists could not be loaded rather than that there is nothing in them', async () => {
    vi.spyOn(repository, 'listRecent').mockRejectedValue(new Error('offline'));
    const wrapper = await mountHome();

    expect(wrapper.text()).toContain('Could not load this listing');
    expect(wrapper.text()).not.toContain('Nothing opened yet');
    expect(useFilesStore().items).toEqual([]);
    wrapper.unmount();
  });

  it('recovers on the retry button once the server answers', async () => {
    const spy = vi.spyOn(repository, 'listRecent').mockRejectedValue(new Error('offline'));
    const wrapper = await mountHome();
    spy.mockRestore();

    await wrapper.findAll('button').find((b) => b.text() === 'Try again')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('Could not load this listing');
    wrapper.unmount();
  });
});
