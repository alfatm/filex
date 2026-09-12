import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '@/App.vue';
import { repository } from '@/data';
import { noCapabilities, noQuota, type Node, type Storage } from '@/data/types';
import { i18n } from '@/i18n';
import { routes } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { useFilesStore } from '@/stores/files';

const storage: Storage = { id: 'demo', serverId: 1, name: 'demo', rootId: 'demo://', quota: noQuota(), shared: false, viaGroups: [] };
const root: Node = { id: 'demo://', name: 'demo', kind: 'folder', parentId: null, size: 0, ownerId: 'u1', shared: false, starred: false };
const user = { id: 'u1', name: 'Me', initial: 'M', email: 'me@filex.test', role: 'member' as const };

/** Every request in this suite answers a tick late: the bug it covers is an ordering one, and instant answers hid it. */
const answer = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));
/** What the server does with a request that needs an account when there is no session: 401, the way it really does. */
let session = false;
const guarded = <T,>(value: T) =>
  new Promise<T>((resolve, reject) => setTimeout(() => (session ? resolve(value) : reject(new Error('unauthorized'))), 5));

/** Long enough for the whole chain — the session check, the sign-in, the drive list and the folder — to settle. */
async function settle() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await flushPromises();
  }
}

/**
 * A cold load at a folder URL with no session: bounced to the sign-in screen, and signing in has to open the
 * folder that was asked for. It used to land there with an empty listing until the person pressed reload.
 */
describe('a folder address reached through the sign-in screen', () => {
  beforeEach(() => {
    session = false;
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'session').mockImplementation(() => answer(session ? user : null) as never);
    vi.spyOn(repository, 'signIn').mockImplementation(() => {
      session = true;
      return answer(user) as never;
    });
    vi.spyOn(repository, 'authOptions').mockImplementation(() => answer({ drivers: ['local'], oidcAutoRedirect: false }) as never);
    vi.spyOn(repository, 'branding').mockRejectedValue(new Error('unbranded'));
    vi.spyOn(repository, 'capabilities').mockImplementation(() => guarded(noCapabilities()) as never);
    vi.spyOn(repository, 'listStorages').mockImplementation(() => guarded([storage]) as never);
    vi.spyOn(repository, 'currentUser').mockImplementation(() => guarded(user) as never);
    vi.spyOn(repository, 'listFilterPeople').mockImplementation(() => guarded([]) as never);
    vi.spyOn(repository, 'resolvePath').mockImplementation(() => answer(root) as never);
    vi.spyOn(repository, 'getNode').mockImplementation(() => answer(root) as never);
    vi.spyOn(repository, 'getPath').mockImplementation(() => answer([]) as never);
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: false });
    vi.spyOn(repository, 'listFolder').mockImplementation(() => answer({ nodes: [], total: 0 }) as never);
  });

  it('opens the folder the guard carried through the sign-in', async () => {
    const history = createMemoryHistory();
    // The address the browser was pointed at, before the app mounts: the first navigation is still pending then,
    // which is the moment the shell must not mistake for a signed-in one.
    history.replace('/files/demo');
    const router = createRouter({ history, routes: [...routes] });
    router.beforeEach(async (to) => {
      const auth = useAuthStore();
      const signedIn = await auth.check();
      if (!auth.checked) return true;
      if (to.meta.public) return signedIn ? { name: 'home' } : true;
      return signedIn ? true : { name: 'login', query: { redirect: to.fullPath } };
    });

    const wrapper = mount(App, { global: { plugins: [router, i18n] } });
    await settle();
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/files/demo');

    await useAuthStore().signIn({ identifier: 'me', password: 'x', remember: false });
    await router.push('/files/demo');
    await settle();

    const files = useFilesStore();
    expect(repository.resolvePath).toHaveBeenCalledWith('demo', '');
    expect(files.folder?.id).toBe(root.id);
    expect(files.error).toBeNull();
    wrapper.unmount();
  });
});
