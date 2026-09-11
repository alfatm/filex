import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { noQuota } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import Sidebar from './Sidebar.vue';

const Page = { template: '<div />' };
const ACTIVE = 'bg-primary-soft';

const drive = (id: string) => ({ id, name: id, rootId: `${id}://`, quota: noQuota(), shared: false, viaGroups: [] });

/** Every sidebar row painted as the current one; on a files route there must be exactly one. */
const activeRows = (wrapper: VueWrapper) => wrapper.findAll('a').filter((a) => a.classes().includes(ACTIVE)).map((a) => a.text());

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
      { id: 'main', name: 'main', rootId: 'main://', quota: noQuota(), shared: false, viaGroups: [] },
      { id: 'demo', name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] },
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
      { id: 'main', name: 'main', rootId: 'main://', quota: noQuota(), shared: false, viaGroups: [] },
      { id: 'demo', name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] },
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
