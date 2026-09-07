import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AdvancedSearchModal from './AdvancedSearchModal.vue';
import { fromUrlQuery, useSearchStore } from './searchStore';

const Page = { template: '<div />' };

async function setup(startAt = '/files') {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/files/:path*', name: 'files', component: Page },
      { path: '/search', name: 'search', component: Page },
    ],
  });
  await router.push(startAt);
  await useFilesStore().bootstrap();
  const store = useSearchStore();
  const wrapper = mount(AdvancedSearchModal, { attachTo: document.body, global: { plugins: [router, i18n] } });
  return { router, store, wrapper };
}

// Headless UI renders the dialog through a portal, so look the fields up on the document.
const field = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

async function setField(label: string, value: string) {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('AdvancedSearchModal', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it('accepts numeric Min/Max bounds and submits on Enter in Min', async () => {
    const { router, store, wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    store.openModal('brief');
    await flushPromises();
    expect(field('Min')).toBeTruthy();

    await setField('Min', '10');
    await setField('Max', '20');
    expect(store.query.size).toMatchObject({ min: 10, max: 20 });
    await setField('Max', '');
    expect(store.query.size.max).toBeNull();

    field('Min').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect(store.open).toBe(false);
    expect(router.currentRoute.value.name).toBe('search');
    expect(router.currentRoute.value.query).toMatchObject({ q: 'brief', min: '10' });
  });

  it('shows the folder from the query and toggles content options through their labels', async () => {
    const { store, wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    store.openModal(undefined, 'Design/Assets');
    await flushPromises();
    expect(document.body.textContent).toContain('Current folder: Assets');

    const checkbox = [...document.body.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
      (el) => el.closest('label')?.textContent?.includes('Case sensitive'),
    )!;
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    // The visible text is the control's <label>, so it names the box (and, in browsers, toggles it).
    expect(checkbox.hasAttribute('aria-label')).toBe(false);
    checkbox.click();
    await nextTick();
    expect(store.query.caseSensitive).toBe(true);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });

  it('cancel on /search puts the URL query back', async () => {
    const { router, store, wrapper } = await setup('/search?q=brief&tags=design');
    cleanup = () => wrapper.unmount();
    store.assign(fromUrlQuery(router.currentRoute.value.query));
    store.openModal();
    await flushPromises();

    await setField('Min', '3');
    store.query.text = 'changed';
    store.query.tags = [];
    await flushPromises();
    expect(store.query.text).toBe('changed');

    button('Cancel').click();
    await flushPromises();
    expect(store.open).toBe(false);
    expect(store.query).toEqual(fromUrlQuery({ q: 'brief', tags: 'design' }));
  });
});
