import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { breakpointMock, setLayout } from '@/test/viewport';
import { noQuota } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import Sidebar from './Sidebar.vue';

vi.mock('@/composables/useBreakpoint', async () => (await import('@/test/viewport')).breakpointMock);
void breakpointMock;

afterEach(() => setLayout('desktop'));

const Page = { template: '<div />' };
const ACTIVE = 'bg-primary-soft';

const drive = (id: string) => ({ id, serverId: 1, name: id, rootId: `${id}://`, quota: noQuota(), shared: false, viaGroups: [] });

/** Every sidebar row painted as the current one; on a files route there must be exactly one. */
const activeRows = (wrapper: VueWrapper) => wrapper.findAll('a').filter((a) => a.classes().includes(ACTIVE)).map((a) => a.text());

const router = () =>
  createRouter({
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

async function mountSidebar() {
  setActivePinia(createPinia());
  const routes = router();
  await routes.push('/files');
  const files = useFilesStore();
  await files.bootstrap();
  const wrapper = mount(Sidebar, { attachTo: document.body, global: { plugins: [routes, i18n] } });
  await nextTick();
  return { files, wrapper };
}

describe('Sidebar storages', () => {
  // The condition used to be the route name alone, so a second drive made every row light up at once.
  it('marks only the drive the listing is in', async () => {
    const { files, wrapper } = await mountSidebar();
    files.storages = [drive('main'), drive('other'), drive('demo')];
    await wrapper.vm.$router.push('/files/other');
    await files.openPath('other', '');
    await nextTick();

    const rows = wrapper.findAll('a').filter((a) => ['other', 'demo'].includes(a.text()));
    expect(rows).toHaveLength(2);
    const active = rows.filter((a) => a.classes().includes(ACTIVE)).map((a) => a.text());
    expect(active).toEqual([files.storage!.name]);
    wrapper.unmount();
  });

  // The home drive is "My files"; listing it under Storages made it look like one more mount to pick.
  it('keeps the home drive off the list', async () => {
    const { files, wrapper } = await mountSidebar();
    files.storages = [
      { id: 'main', serverId: 1, name: 'main', rootId: 'main://', quota: noQuota(), shared: false, viaGroups: [] },
      { id: 'demo', serverId: 1, name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] },
    ];
    await nextTick();

    const rows = wrapper.findAll('a').filter((a) => ['main', 'demo'].includes(a.text()));
    expect(rows.map((a) => a.text())).toEqual(['demo']);

    // With nothing but the home drive there is no section to head.
    files.storages = files.storages.slice(0, 1);
    await nextTick();
    expect(wrapper.text()).not.toContain('Storages');
    wrapper.unmount();
  });

  // The row links to `/files` with no drive in it, which vue-router reads as an ancestor of every `/files/...`:
  // "My files" painted itself while the listing was on a completely different mount.
  it('marks "My files" for the home drive only, whatever files route is open', async () => {
    const { files, wrapper } = await mountSidebar();
    files.storages = [
      { id: 'main', serverId: 1, name: 'main', rootId: 'main://', quota: noQuota(), shared: false, viaGroups: [] },
      { id: 'demo', serverId: 1, name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] },
    ];
    const myFiles = () => wrapper.findAll('a').find((a) => a.text() === 'My files')!;
    await wrapper.vm.$router.push('/files/main');
    await files.openPath('main', '');
    await nextTick();
    expect(myFiles().classes()).toContain(ACTIVE);

    await wrapper.vm.$router.push('/files/demo');
    await files.openPath('demo', '');
    await nextTick();
    expect(myFiles().classes()).not.toContain(ACTIVE);
    // The drive whose listing it is takes the highlight instead.
    expect(wrapper.findAll('a').find((a) => a.text() === 'demo')!.classes()).toContain(ACTIVE);
    wrapper.unmount();
  });

  /**
   * The demo dataset has one drive and it is NOT called `main`. Comparing against the `main` constant left
   * "My files" dark on every route there and handed the highlight to the drive row instead — and the drive row
   * was itself only listed because the constant did not recognise it as the home drive.
   */
  it('marks "My files" for the drive a bare files route opens, whatever that drive is called', async () => {
    const { files, wrapper } = await mountSidebar();
    files.storages = [drive('demo'), drive('archive')];
    await wrapper.vm.$router.push('/files/demo');
    await files.openPath('demo', '');
    await nextTick();

    // The default drive is "My files"; the Storages section lists what is left, so nothing is offered twice.
    expect(wrapper.findAll('a').filter((a) => ['demo', 'archive'].includes(a.text())).map((a) => a.text())).toEqual(['archive']);
    expect(activeRows(wrapper)).toEqual(['My files']);

    await wrapper.vm.$router.push('/files/archive');
    await files.openPath('archive', '');
    await nextTick();
    expect(activeRows(wrapper)).toEqual(['archive']);
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

/** The hamburger, by its label — `[aria-expanded]` alone also matches the New button's menu state. */
const MENU_TOGGLE = 'button[aria-label="Expand menu"], button[aria-label="Collapse menu"]';

describe('Sidebar shapes', () => {
  // The drawer's copy is always the full column — a rail inside a drawer would be a menu hiding its own labels —
  // and its hamburger is the way back out.
  it('closes the drawer from the same glyph', async () => {
    setActivePinia(createPinia());
    const view = useViewStore();
    view.drawerOpen = true;
    const wrapper = mount(Sidebar, { props: { drawer: true }, global: { plugins: [router(), i18n] } });
    await nextTick();

    expect(wrapper.get('nav').attributes('style')).toContain('280px');
    await wrapper.get('button[aria-label="Close menu"]').trigger('click');
    expect(view.drawerOpen).toBe(false);
    wrapper.unmount();
  });

  // Spec §10: the drawer is the phone's ONE way in, and it carries no New button — the `+` in the listing
  // toolbar is the single entry point there.
  it('leaves New out of the phone drawer', async () => {
    setLayout('mobile');
    setActivePinia(createPinia());
    const wrapper = mount(Sidebar, { props: { drawer: true }, global: { plugins: [router(), i18n] } });
    await nextTick();

    expect(wrapper.find('button[aria-haspopup="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps the toggle, and the stored width, beside the listing', async () => {
    const { wrapper } = await mountSidebar();
    expect(wrapper.get('nav').attributes('style')).toContain('192px');
    expect(wrapper.findAll(MENU_TOGGLE).length).toBe(1);
    wrapper.unmount();
  });
});
