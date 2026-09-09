import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import AccessModal from './AccessModal.vue';
import DestinationModal from './DestinationModal.vue';
import ShareModal from './ShareModal.vue';
import TagsModal from './TagsModal.vue';
import VersionsModal from './VersionsModal.vue';

/**
 * What each modal does when the repository refuses.
 *
 * Every one of these used to answer the same way — nothing on screen, an unhandled rejection in the console — and
 * in the tags modal that silence WROTE: an unread list saved back is an erased one.
 */

const node: Node = { id: 'demo://Docs/brief.pdf', name: 'brief.pdf', kind: 'file', parentId: 'demo://Docs', size: 10, ownerId: 'u1', shared: false, starred: false };

const Page = { template: '<div />' };

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: Page }] });
  await router.push('/files');
  const files = useFilesStore();
  await files.bootstrap();
  return { files, router };
}

const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const field = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

describe('modals when the repository refuses', () => {
  let wrapper: { unmount: () => void } | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
  });

  // The one item on this list that loses data: the tag list is written back WHOLE, so saving before the read has
  // landed writes a list the file's own tags are missing from.
  it('the tags modal will not save a list it never read', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'listTags').mockRejectedValue(new Error('tags are down'));
    const setTags = vi.spyOn(repository, 'setTags');
    wrapper = mount(TagsModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    expect(text()).toContain('tags are down');
    expect(button('Save')?.disabled).toBe(true);
    button('Save')?.click();
    await flushPromises();
    expect(setTags).not.toHaveBeenCalled();
  });

  it('the tags modal saves once the list is known', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'listTags').mockResolvedValue(['invoices']);
    const setTags = vi.spyOn(repository, 'setTags').mockResolvedValue(undefined);
    wrapper = mount(TagsModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    expect(button('Save')?.disabled).toBe(false);
    const box = field('Tags');
    box.value = 'paid';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    button('Save')?.click();
    await flushPromises();
    expect(setTags).toHaveBeenCalledWith(node.id, ['invoices', 'paid']);
  });

  // A switch that says "off" for a node that has a link mints a SECOND one on the next press.
  it('the share modal disables the switch when the current link could not be read', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'shareLink').mockRejectedValue(new Error('link unknown'));
    const create = vi.spyOn(repository, 'createShareLink');
    wrapper = mount(ShareModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    expect(text()).toContain('link unknown');
    expect(document.body.querySelector('button[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('the share modal says why a link was not created', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'shareLink').mockResolvedValue(null);
    vi.spyOn(repository, 'createShareLink').mockRejectedValue(new Error('not allowed to share'));
    wrapper = mount(ShareModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    const toggle = document.body.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.hasAttribute('disabled')).toBe(false);
    toggle.click();
    await flushPromises();
    expect(text()).toContain('not allowed to share');
    // The switch reads the link, and there is none, so it is back where it was rather than showing a link that is not there.
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('the access modal says why an invite was refused and keeps the address', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'listPeople').mockResolvedValue({ people: [], canManage: true });
    vi.spyOn(repository, 'addPerson').mockRejectedValue(new Error('no such account'));
    wrapper = mount(AccessModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    const email = field('Email address');
    email.value = 'ghost@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    button('Invite')?.click();
    await flushPromises();

    expect(text()).toContain('no such account');
    expect(field('Email address').value).toBe('ghost@example.com');
  });

  it('the versions modal says why a restore did not happen, and announces nothing', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'listVersions').mockResolvedValue([
      { id: 'v2', at: '2024-05-02T10:00:00Z', size: 20 },
      { id: 'v1', at: '2024-05-01T10:00:00Z', size: 10 },
    ]);
    vi.spyOn(repository, 'restoreVersion').mockRejectedValue(new Error('revision is gone'));
    wrapper = mount(VersionsModal, { props: { node }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    button('Restore')?.click();
    await flushPromises();
    expect(text()).toContain('revision is gone');
    expect(useToastStore().toasts).toEqual([]);
  });

  it('the destination modal stops saying "Searching…" when the folder search fails', async () => {
    const { router } = await setup();
    vi.spyOn(repository, 'searchFolders').mockRejectedValue(new Error('search is down'));
    wrapper = mount(DestinationModal, { props: { nodes: [node], mode: 'move' }, attachTo: document.body, global: { plugins: [router, i18n] } });
    await flushPromises();

    vi.useFakeTimers();
    try {
      const filter = field('Filter folders');
      filter.value = 'design';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();
      expect(text()).toContain('Searching…');

      await vi.advanceTimersByTimeAsync(400);
      expect(text()).not.toContain('Searching…');
      expect(text()).toContain('search is down');
    } finally {
      vi.useRealTimers();
    }
  });
});
