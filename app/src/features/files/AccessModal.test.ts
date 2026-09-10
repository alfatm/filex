import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import type { Node, Person } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AccessModal from './AccessModal.vue';

/**
 * What the modal costs.
 *
 * Reading who has access changes nothing, so it must not re-read the folder: `load` used to end in
 * `files.refresh()`, which meant opening the modal re-listed the whole folder and — through `focusNode` — asked
 * for the focused node's people and location all over again.
 */

const node: Node = { id: 'demo://Docs/brief.pdf', name: 'brief.pdf', kind: 'file', parentId: 'demo://Docs', size: 10, ownerId: 'u1', shared: false, starred: false };

const Page = { template: '<div />' };

async function setup(people: Person[] = []) {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: Page }] });
  await router.push('/files');
  const files = useFilesStore();
  await files.bootstrap();
  const refresh = vi.spyOn(files, 'refresh').mockResolvedValue(undefined);
  vi.spyOn(repository, 'listPeople').mockResolvedValue({ people, canManage: true });
  const wrapper = mount(AccessModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
  await flushPromises();
  return { wrapper, refresh };
}

const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const field = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

describe('AccessModal', () => {
  let wrapper: { unmount: () => void } | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
  });

  it('does not re-read the listing just to show who has access', async () => {
    const opened = await setup();
    wrapper = opened.wrapper;
    expect(repository.listPeople).toHaveBeenCalledWith(node.id);
    expect(opened.refresh).not.toHaveBeenCalled();
  });

  it('re-reads the listing after a grant, which changes what the row shows', async () => {
    const opened = await setup();
    wrapper = opened.wrapper;
    vi.spyOn(repository, 'addPerson').mockResolvedValue(undefined);

    const email = field('Email address');
    email.value = 'someone@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    button('Invite')?.click();
    await flushPromises();

    expect(repository.addPerson).toHaveBeenCalled();
    expect(opened.refresh).toHaveBeenCalledTimes(1);
  });

  // A refused role change leaves the server's state exactly as it was, so there is nothing outside to re-read.
  it('does not re-read the listing when a role change is refused', async () => {
    const opened = await setup([{ id: 'her@example.com', name: 'Her', initial: 'H', role: 'viewer' }]);
    wrapper = opened.wrapper;
    vi.spyOn(repository, 'setPersonRole').mockRejectedValue(new Error('not allowed'));

    const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Role of Her"]');
    expect(select).not.toBeNull();
    select!.value = 'editor';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(document.body.textContent).toContain('not allowed');
    expect(opened.refresh).not.toHaveBeenCalled();
  });
});
