import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { noQuota } from '@/data/types';
import { useDragStore } from '@/features/files/dragStore';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AppShell from './AppShell.vue';

const Page = { template: '<div />' };

async function mountShell() {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/recent', name: 'recent', component: Page },
      { path: '/files/:path*', name: 'files', component: Page },
      { path: '/', name: 'home', component: Page },
      { path: '/shared', name: 'shared', component: Page },
      { path: '/starred', name: 'starred', component: Page },
      { path: '/trash', name: 'trash', component: Page },
      { path: '/connect', name: 'connect', component: Page },
      { path: '/api-keys', name: 'apiKeys', component: Page },
    ],
  });
  // Recent has no drop zone of its own; before this shell, a file dropped there took the browser to the file.
  await router.push('/recent');
  const files = useFilesStore();
  await files.bootstrap();
  const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [router, i18n] } });
  await nextTick();
  return { wrapper, files, drag: useDragStore() };
}

/** jsdom has no DragEvent; what the handlers read is the type list and the effect. */
function dragEvent(type: string, types: string[] = ['Files']) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, dropEffect: 'copy' } });
  return event as Event & { dataTransfer: { dropEffect: string } };
}

describe('AppShell drop guard', () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  it('refuses a file the page did not offer to take, instead of letting the browser navigate to it', async () => {
    const { wrapper, drag } = await mountShell();
    close = () => wrapper.unmount();

    const over = dragEvent('dragover');
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(drag.files).toBe(true);

    const drop = dragEvent('drop');
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(drag.files).toBe(false);
  });

  it('leaves the effect a drop zone in the page already chose', async () => {
    const { wrapper } = await mountShell();
    close = () => wrapper.unmount();

    const zone = (event: Event) => event.preventDefault();
    document.body.addEventListener('dragover', zone);
    const over = dragEvent('dragover');
    document.body.dispatchEvent(over);
    document.body.removeEventListener('dragover', zone);
    expect(over.dataTransfer.dropEffect).toBe('copy');
  });

  it('ignores a drag carrying no files at all', async () => {
    const { wrapper } = await mountShell();
    close = () => wrapper.unmount();

    const over = dragEvent('dragover', ['text/plain']);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });

  // There is no `dragend` for a drag that began outside the browser: the flag stayed on for the rest of the
  // session, and every folder then lit up for the next drag inside the app.
  it('forgets the OS drag once it has left the window', async () => {
    const { wrapper, drag } = await mountShell();
    close = () => wrapper.unmount();

    document.body.dispatchEvent(dragEvent('dragenter'));
    document.body.dispatchEvent(dragEvent('dragover'));
    expect(drag.files).toBe(true);

    document.body.dispatchEvent(dragEvent('dragleave'));
    expect(drag.files).toBe(false);
  });

  // Crossing into a child fires `dragleave` too; only the last one out means the drag is really gone.
  it('stays armed while the pointer only crosses between elements', async () => {
    const { wrapper, drag } = await mountShell();
    close = () => wrapper.unmount();

    document.body.dispatchEvent(dragEvent('dragenter'));
    document.body.dispatchEvent(dragEvent('dragover'));
    document.body.dispatchEvent(dragEvent('dragenter'));
    document.body.dispatchEvent(dragEvent('dragleave'));
    expect(drag.files).toBe(true);
  });
});

describe('AppShell drive usage', () => {
  // Read once at start-up, the figures never moved again: the quota bar stayed where it was after an upload, a
  // delete and an emptied trash alike.
  it('reads the drive list again after a mutation', async () => {
    const { wrapper, files } = await mountShell();
    const listed = vi.spyOn(repository, 'listStorages').mockResolvedValue([
      { id: 'demo', serverId: 1, name: 'demo', rootId: 'demo://', quota: { ...noQuota(), usedBytes: 42, totalBytes: 100 }, shared: false, viaGroups: [] },
    ]);

    await files.reload();
    await nextTick();

    expect(listed).toHaveBeenCalled();
    expect(files.storages[0].quota.usedBytes).toBe(42);
    listed.mockRestore();
    wrapper.unmount();
  });
});
