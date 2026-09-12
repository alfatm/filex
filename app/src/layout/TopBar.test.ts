import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/features/settings/settingsStore';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import TopBar from './TopBar.vue';

const Page = { template: '<div />' };

async function mountBar() {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/files/:path*', name: 'files', component: Page },
      { path: '/search', name: 'search', component: Page },
    ],
  });
  await router.push('/files');
  await useFilesStore().bootstrap();
  return mount(TopBar, { attachTo: document.body, global: { plugins: [router, i18n] } });
}

/** Opens the account menu and returns its entry labels. FloatingMenu renders in place, inside the header. */
async function accountEntries(role: 'admin' | 'member') {
  const wrapper = await mountBar();
  const files = useFilesStore();
  files.user = { ...files.user!, role };
  await nextTick();
  await wrapper.get('button[aria-haspopup="menu"]').trigger('click');
  await nextTick();
  const labels = wrapper.findAll('[role="menu"] button').map((b) => b.text());
  wrapper.unmount();
  return labels;
}

describe('TopBar account menu', () => {
  // The admin panel bounces anyone who is not an admin, so an entry offered to a member is a link to a bounce.
  it('offers the admin console to an admin', async () => {
    expect(await accountEntries('admin')).toContain('Admin settings');
  });

  it('hides it from a member', async () => {
    const labels = await accountEntries('member');
    expect(labels).not.toContain('Admin settings');
    expect(labels).toContain('User settings');
  });
});

describe('TopBar type-to-search', () => {
  // The listing takes a bare `r` as Refresh and prevents the default. This listens on the window, so it saw the
  // same key afterwards and threw focus into the search box: the folder reloaded AND the caret left the table,
  // after which the next arrow key and the next Delete went into the input.
  it('leaves a key a page handler already took, and still takes an untouched one', async () => {
    const wrapper = await mountBar();
    const box = wrapper.get('input').element;

    // What the listing does with its Refresh key: consume it, on the way to the window.
    const listing = (event: Event) => event.preventDefault();
    document.body.addEventListener('keydown', listing);
    const handled = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    document.body.dispatchEvent(handled);
    document.body.removeEventListener('keydown', listing);
    expect(handled.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(box);

    const typed = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    document.body.dispatchEvent(typed);
    expect(document.activeElement).toBe(box);
    wrapper.unmount();
  });
});

describe('TopBar assistant trigger', () => {
  // The setting closes the panel again the moment it opens, so a button gated on the server alone offered a door
  // that shuts itself.
  it('is offered only where the server has an assistant and this browser has it switched on', async () => {
    const wrapper = await mountBar();
    const capabilities = useCapabilitiesStore();
    const settings = useSettingsStore();
    const trigger = () => wrapper.findAll('button').find((b) => b.attributes('aria-label') === 'AI assistant');

    capabilities.can = { ...capabilities.can, assistant: true };
    settings.apply({ ...settings.settings, assistantEnabled: true });
    await nextTick();
    expect(trigger()).toBeDefined();

    settings.apply({ ...settings.settings, assistantEnabled: false });
    await nextTick();
    expect(trigger()).toBeUndefined();

    settings.apply({ ...settings.settings, assistantEnabled: true });
    capabilities.can = { ...capabilities.can, assistant: false };
    await nextTick();
    expect(trigger()).toBeUndefined();
    wrapper.unmount();
  });
});

describe('TopBar theme button', () => {
  // Three states on one control, so the order it walks them in is the whole behaviour.
  it('cycles light → system → dark → light and applies each', async () => {
    const wrapper = await mountBar();
    const settings = useSettingsStore();
    settings.settings.theme = 'light';
    await nextTick();

    const button = () => wrapper.findAll('button').find((b) => b.attributes('aria-label')?.startsWith('Theme:'))!;
    expect(button().attributes('aria-label')).toBe('Theme: Light. Switch to System');

    await button().trigger('click');
    expect(settings.settings.theme).toBe('system');
    // "System" is the absence of the attribute: tokens.css then follows prefers-color-scheme on its own.
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await button().trigger('click');
    expect(settings.settings.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await button().trigger('click');
    expect(settings.settings.theme).toBe('light');
    wrapper.unmount();
  });
});

describe('TopBar search box', () => {
  // The box used to be a local ref only: a shared `/search?q=…` link opened with an empty field, and the modal's
  // own submit did not show up in it either.
  it('shows the query the results route carries', async () => {
    const wrapper = await mountBar();
    await wrapper.vm.$router.push({ name: 'search', query: { q: 'foo' } });
    await nextTick();
    expect(wrapper.get('input').element.value).toBe('foo');
    wrapper.unmount();
  });

  // The native cancel button (the X in a `type="search"` box) fires `search` and empties the input, nothing else.
  // On the results page that left the hits and chips of a query nobody was asking for any more.
  it('drops the query from the URL when the box is cleared', async () => {
    const wrapper = await mountBar();
    const router = wrapper.vm.$router;
    await router.push({ name: 'search', query: { q: 'foo' } });
    await nextTick();

    const box = wrapper.get('input');
    await box.setValue('');
    await box.trigger('search');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('search');
    expect(router.currentRoute.value.query).toEqual({});
    wrapper.unmount();
  });

  // Elsewhere the box is just a box: clearing it must not throw the person onto an empty results page.
  it('leaves other routes alone', async () => {
    const wrapper = await mountBar();
    const router = wrapper.vm.$router;
    const box = wrapper.get('input');
    await box.setValue('foo');
    await box.setValue('');
    await box.trigger('search');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('files');
    wrapper.unmount();
  });
});
