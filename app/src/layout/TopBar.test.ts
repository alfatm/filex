import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/features/settings/settingsStore';
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
