import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { RBAC_DISABLED } from '@/data/repository';
import type { Access, GroupOption, Node } from '@/data/types';
import { createMemoryHistory, createRouter } from 'vue-router';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AccessModal from './AccessModal.vue';

const folder: Node = { id: 'demo://Docs', name: 'Docs', kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'u1', shared: false, starred: false };

const access = (patch: Partial<Access> = {}): Access => ({
  people: [{ id: '1', name: 'Ada', initial: 'A', role: 'owner', principal: 'user' }],
  canManage: true,
  ...patch,
});

/** The Copy button behind a minted link goes through `useFileActions`, which wants a router to be there. */
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { template: '<div />' } }] });

function open() {
  return mount(AccessModal, { attachTo: document.body, props: { node: folder }, global: { plugins: [i18n, router] } });
}

/** The modal is teleported, so its markup is in the document rather than under the mounted wrapper. */
function panel(selector: string): Element | null {
  return document.body.querySelector(selector);
}

function all(selector: string): Element[] {
  return [...document.body.querySelectorAll(selector)];
}

/** Types into one of the modal's own boxes and lets Vue see it. */
async function type(index: number, text: string) {
  const box = all('input')[index] as HTMLInputElement;
  box.value = text;
  box.dispatchEvent(new Event('input'));
  await flushPromises();
}

describe('AccessModal', () => {
  let wrapper: { unmount: () => void } | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    // Opening the modal refreshes the listing behind it whenever something changed.
    vi.spyOn(useFilesStore(), 'refresh').mockResolvedValue();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
  });

  // filex grants to groups as well as to accounts, and a group row carries no face and no address: what says who
  // it reaches is its size.
  it('draws a group grant as a group, with how many people are in it', async () => {
    vi.spyOn(repository, 'listPeople').mockResolvedValue(
      access({ people: [{ id: 'g:7', name: 'Design', initial: 'D', role: 'editor', principal: 'group', memberCount: 12 }] }),
    );
    wrapper = open();
    await flushPromises();

    expect(document.body.textContent).toContain('Design');
    expect(document.body.textContent).toContain('12 members');
  });

  // Handing a folder over is a thing people do, and filex's ACL has the level — but it is never offered to a
  // reader, whose whole modal is a list.
  it('offers Owner as a level to somebody who may manage access, and nothing at all to somebody who may not', async () => {
    const listed = vi.spyOn(repository, 'listPeople').mockResolvedValue(access());
    wrapper = open();
    await flushPromises();
    expect(panel('form')).not.toBeNull();
    expect(document.body.textContent).toContain('Owner');

    wrapper.unmount();
    listed.mockResolvedValue(access({ canManage: false }));
    wrapper = open();
    await flushPromises();
    expect(panel('form')).toBeNull();
  });

  // `is_dir` used to be hard-coded to `true`, so a grant on a FILE was recorded against a folder that is not there.
  it('invites a group with the node’s own kind, not a constant', async () => {
    vi.spyOn(repository, 'listPeople').mockResolvedValue(access());
    vi.spyOn(repository, 'searchGroups').mockResolvedValue([{ id: '7', name: 'Design', memberCount: 12 }]);
    const invite = vi.spyOn(repository, 'addPerson').mockResolvedValue({ mode: 'granted' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wrapper = open();
    await flushPromises();

    // The People | Group toggle, then the type-ahead, which asks the server a beat after the typing stops.
    all('[role="radio"]')[1].dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    await type(0, 'des');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();

    all('button').find((b) => b.textContent?.includes('Design'))!.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    panel('form')!.dispatchEvent(new Event('submit'));
    await flushPromises();

    expect(invite).toHaveBeenCalledWith('demo://Docs', { groupId: '7' }, 'viewer', true);
    vi.useRealTimers();
  });

  /*
   * The debounce spaces the questions out; it does not cancel the one already asked. So two answers can be in
   * flight, and they can come back in either order — the answer to `des` landing after the answer to `design`
   * used to repopulate the dropdown with matches for a word nobody had typed any more.
   */
  it('keeps the newest matches when an older search answers last', async () => {
    vi.spyOn(repository, 'listPeople').mockResolvedValue(access());
    /** One deferred answer per query, resolved by the test in whatever order it likes. */
    const answers = new Map<string, (groups: GroupOption[]) => void>();
    vi.spyOn(repository, 'searchGroups').mockImplementation(
      (query: string) => new Promise((resolve) => answers.set(query, resolve)),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wrapper = open();
    await flushPromises();
    all('[role="radio"]')[1].dispatchEvent(new MouseEvent('click'));
    await flushPromises();

    await type(0, 'des');
    await vi.advanceTimersByTimeAsync(300);
    await type(0, 'design');
    await vi.advanceTimersByTimeAsync(300);
    expect([...answers.keys()]).toEqual(['des', 'design']);

    answers.get('design')!([{ id: '7', name: 'Design System', memberCount: 12 }]);
    await flushPromises();
    expect(document.body.textContent).toContain('Design System');

    answers.get('des')!([{ id: '9', name: 'Desktop Team', memberCount: 3 }]);
    await flushPromises();
    expect(document.body.textContent).toContain('Design System');
    expect(document.body.textContent).not.toContain('Desktop Team');
    vi.useRealTimers();
  });

  // And the same answer landing after the person has CHOSEN: the list is closed by the pick, and an answer to a
  // question asked before it must not open it again over the selection.
  it('does not reopen the match list when an answer lands after a pick', async () => {
    vi.spyOn(repository, 'listPeople').mockResolvedValue(access());
    const answers = new Map<string, (groups: GroupOption[]) => void>();
    vi.spyOn(repository, 'searchGroups').mockImplementation(
      (query: string) => new Promise((resolve) => answers.set(query, resolve)),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wrapper = open();
    await flushPromises();
    all('[role="radio"]')[1].dispatchEvent(new MouseEvent('click'));
    await flushPromises();

    await type(0, 'de');
    await vi.advanceTimersByTimeAsync(300);
    answers.get('de')!([{ id: '7', name: 'Design', memberCount: 12 }]);
    await flushPromises();
    // A further keystroke asks again, with the first list still on screen to choose from.
    await type(0, 'des');
    await vi.advanceTimersByTimeAsync(300);
    all('button').find((b) => b.textContent?.includes('Design'))!.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(panel('ul[aria-label="Matching groups"]')).toBeNull();

    answers.get('des')!([{ id: '9', name: 'Desktop Team', memberCount: 3 }]);
    await flushPromises();
    expect(panel('ul[aria-label="Matching groups"]')).toBeNull();
    vi.useRealTimers();
  });

  // There is no account to add, so adding a row would be a lie; the link IS the outcome and is the only place it
  // is ever shown.
  it('shows the public link an invite minted instead of a grant, and adds nobody', async () => {
    vi.spyOn(repository, 'listPeople').mockResolvedValue(access({ people: [] }));
    vi.spyOn(repository, 'addPerson').mockResolvedValue({ mode: 'shared', url: 'https://filex.test/s/abc' });
    wrapper = open();
    await flushPromises();

    await type(0, 'nobody@filex.test');
    panel('form')!.dispatchEvent(new Event('submit'));
    await flushPromises();

    expect(document.body.textContent).toContain('https://filex.test/s/abc');
    expect(document.body.textContent).toContain('public link was created instead');
    expect(all('li')).toHaveLength(0);
  });

  // Nothing about the invite is wrong: the drive keeps no access rules at all, and only an administrator can
  // change that — so the modal says who to ask instead of showing the server's sentence about RBAC.
  it('says who can fix a drive with access rules switched off', async () => {
    vi.spyOn(repository, 'listPeople').mockResolvedValue(access());
    vi.spyOn(repository, 'addPerson').mockRejectedValue(new Error(RBAC_DISABLED));
    wrapper = open();
    await flushPromises();

    await type(0, 'mert@filex.test');
    panel('form')!.dispatchEvent(new Event('submit'));
    await flushPromises();

    expect(panel('[role="alert"]')?.textContent).toContain('ask an administrator');
  });
});
