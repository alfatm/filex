import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import NotFoundPage from './NotFoundPage.vue';

const Page = { template: '<div />' };

describe('NotFoundPage', () => {
  // It borrowed the listing's "Folder not found", which is a sentence about a folder — and the addresses that land
  // here are anything but: `/nowhere/at/all` names no folder, and telling somebody a folder is missing sends them
  // looking for one.
  it('says the ADDRESS has no page, not that a folder is missing', async () => {
    i18n.global.locale.value = 'en';
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'home', component: Page }] });
    await router.push('/');
    const wrapper = mount(NotFoundPage, { global: { plugins: [router, i18n] } });

    expect(wrapper.text()).toContain('Page not found');
    expect(wrapper.text()).not.toContain('Folder not found');
    wrapper.unmount();
  });
});
