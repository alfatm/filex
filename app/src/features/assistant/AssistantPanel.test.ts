import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantEvent, AssistantMode, SearchHit } from '@/data/types';
import { i18n } from '@/i18n';
import AssistantPanel from './AssistantPanel.vue';
import { useAssistantStore } from './assistantStore';

const calls: { prompt: string; mode: AssistantMode }[] = [];
const approvals: { id: string; path: string; allow: boolean }[] = [];
const decisions: { id: string; planId: string; approve: boolean }[] = [];
let script: AssistantEvent[] = [];
let release: (() => void) | null = null;

// happy-dom exposes no localStorage here; the stores only need getItem/setItem/removeItem.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
  removeItem: (key: string) => backing.delete(key),
});

vi.mock('@/data', () => ({
  repository: {
    previewUrl: () => undefined,
    async assistantMessages() {
      return { messages: [{ id: 'm1', role: 'assistant', text: 'We spoke earlier.', at: '2026-07-10T10:24:00' }], granted: [] };
    },
    async listStorages() {
      return [];
    },
    async currentUser() {
      return { id: 'demo', name: 'demo', initial: 'D' };
    },
    async createAssistantSession() {
      return { id: 's1', title: '', titleManual: false, messageCount: 0, lastActiveAt: '', createdAt: '' };
    },
    async decideAssistantRead(id: string, path: string, allow: boolean) {
      approvals.push({ id, path, allow });
    },
    async decideAssistantPlan(id: string, planId: string, approve: boolean) {
      decisions.push({ id, planId, approve });
      return approve
        ? { status: 'done' as const, results: [{ path: 'main://Docs/a.pdf', state: 'skipped' as const, code: 'changed' }], done: 0, skipped: 1, failed: 0 }
        : { status: 'cancelled' as const, results: [], done: 0, skipped: 0, failed: 0 };
    },
    async *assistantAsk(prompt: string, mode: AssistantMode) {
      calls.push({ prompt, mode });
      for (const event of script) {
        await new Promise<void>((resolve) => (release = resolve));
        yield event;
      }
    },
  },
}));

async function setup() {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files/:path*', name: 'files', component: { template: '<div />' } }] });
  await router.push('/files');
  const wrapper = mount(AssistantPanel, { attachTo: document.body, global: { plugins: [router, i18n] } });
  return { wrapper, store: useAssistantStore() };
}

const textarea = (wrapper: ReturnType<typeof mount>) => wrapper.find<HTMLTextAreaElement>('textarea');
const radios = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[role="radio"]');

describe('AssistantPanel', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    calls.length = 0;
    release = null;
    backing.clear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('focuses the textarea on mount and closes on Escape from anywhere in the window', async () => {
    const { wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    expect(document.activeElement).toBe(textarea(wrapper).element);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toHaveLength(1);
    // A layer that already handled Escape (menu, dialog) keeps the panel open.
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('comes back to the conversation the last panel showed', async () => {
    backing.set('filex.app.assistant.session', 's9');
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    await flushPromises();
    expect(store.sessionId).toBe('s9');
    expect(wrapper.text()).toContain('We spoke earlier.');
  });

  it('sends the draft on Enter, clears it, and keeps typing possible while the answer streams', async () => {
    script = [{ type: 'text', delta: 'hi' }, { type: 'done' }];
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    await textarea(wrapper).setValue('where is the readme?');
    await textarea(wrapper).trigger('keydown', { key: 'Enter' });
    // The box empties and the panel goes into its streaming state at once; the request itself waits for the
    // conversation the turn will be written into.
    expect(textarea(wrapper).element.value).toBe('');
    expect(store.streaming).toBe(true);
    await flushPromises();
    expect(calls).toEqual([{ prompt: 'where is the readme?', mode: 'filename' }]);
    await nextTick();
    expect(textarea(wrapper).attributes('disabled')).toBeUndefined();
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('button[aria-label="Send"]').exists()).toBe(true);
    for (const _ of script) {
      await vi.waitFor(() => expect(release).not.toBeNull());
      const open = release!;
      release = null;
      open();
    }
    await flushPromises();
    expect(store.streaming).toBe(false);
    expect(wrapper.find('[role="log"]').text()).toContain('hi');
    expect(wrapper.find('[role="status"]').text()).toBe('hi');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  it('shows Offline, disables the input row and refuses to send while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    expect(wrapper.text()).toContain('Offline');
    expect(textarea(wrapper).attributes('disabled')).toBeDefined();
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
    await textarea(wrapper).trigger('keydown', { key: 'Enter' });
    expect(calls).toEqual([]);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    await nextTick();
    expect(wrapper.text()).toContain('Online');
    expect(textarea(wrapper).attributes('disabled')).toBeUndefined();
  });

  it('exposes the modes as a roving radiogroup driven by the arrow keys', async () => {
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    expect(wrapper.find('[role="radiogroup"]').attributes('aria-label')).toBe('Search mode');
    expect(radios(wrapper).map((r) => [r.attributes('aria-checked'), r.attributes('tabindex')])).toEqual([
      ['true', '0'],
      ['false', '-1'],
      ['false', '-1'],
    ]);
    await radios(wrapper)[0].trigger('keydown', { key: 'ArrowRight' });
    expect(store.mode).toBe('content');
    expect(document.activeElement).toBe(radios(wrapper)[1].element);
    await radios(wrapper)[1].trigger('keydown', { key: 'ArrowLeft' });
    await radios(wrapper)[0].trigger('keydown', { key: 'ArrowLeft' });
    expect(store.mode).toBe('tags');
    expect(radios(wrapper)[2].attributes('tabindex')).toBe('0');
  });

  it('renders the error and stopped hints, and says who has to act on the failures that are not "try again"', async () => {
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.seed([
      { id: 'a', role: 'user', text: 'q', at: '2026-07-10T10:24:00' },
      { id: 'b', role: 'assistant', text: 'partial', at: '2026-07-10T10:24:00', aborted: true },
      { id: 'c', role: 'assistant', text: '', at: '2026-07-10T10:24:00', error: 'failed' },
      { id: 'd', role: 'assistant', text: '', at: '2026-07-10T10:24:00', error: 'quota' },
      { id: 'e', role: 'assistant', text: '', at: '2026-07-10T10:24:00', error: 'unavailable' },
      { id: 'f', role: 'assistant', text: '', at: '2026-07-10T10:24:00', error: 'timeout' },
    ]);
    await nextTick();
    expect(wrapper.text()).toContain('Stopped');
    expect(wrapper.text()).toContain('Something went wrong. Please try again.');
    expect(wrapper.text()).toContain('out of credit. Ask an administrator');
    expect(wrapper.text()).toContain('The assistant is no longer available');
    expect(wrapper.text()).toContain('No answer came for a minute');
  });

  // The model's first word can be many seconds away; a panel showing nothing for them reads as a request that
  // never left.
  it('says it is thinking from the question until the first word arrives', async () => {
    script = [{ type: 'text', delta: 'Hello' }, { type: 'done' }];
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    const turn = store.send('q');
    await flushPromises();
    expect(wrapper.text()).toContain('Thinking…');

    release!();
    await flushPromises();
    expect(wrapper.text()).toContain('Hello');
    expect(wrapper.text()).not.toContain('Thinking…');
    release!();
    await turn;
  });

  it('asks for one file at a time, and the answer goes to the waiting turn — nothing is typed into the chat', async () => {
    script = [{ type: 'done' }];
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.sessionId = 's1';
    store.seed([
      { id: 'm1', role: 'user', text: 'summarise pay', at: '2026-07-01T10:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        text: 'I need the pay file.',
        at: '2026-07-01T10:00:01Z',
        cards: [{ kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' }],
      },
    ]);
    await nextTick();

    expect(wrapper.text()).toContain('May I open this file?');
    expect(wrapper.text()).toContain('main://Docs/pay.csv');
    expect(wrapper.text()).toContain('to total the salaries');

    const before = calls.length;
    const allow = wrapper.findAll('button').find((b) => b.text() === 'Allow this file');
    await allow!.trigger('click');
    await flushPromises();
    // The answer is recorded for that one path; no message is sent for it.
    expect(approvals).toEqual([{ id: 's1', path: 'main://Docs/pay.csv', allow: true }]);
    expect(calls).toHaveLength(before);
    await nextTick();
    expect(wrapper.text()).toContain('You allowed this file');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Allow this file')).toBe(false);
  });

  it('draws a report as a card with the count and downloads it as text or CSV, built in the browser', async () => {
    const saved: { name: string; type: string }[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: (blob: Blob) => `blob:${blob.type}`, revokeObjectURL: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, type: this.href.slice('blob:'.length) });
    });
    const { wrapper, store } = await setup();
    cleanup = () => {
      wrapper.unmount();
      click.mockRestore();
      vi.unstubAllGlobals();
    };
    const row = (id: string, name: string) => ({ node: { id, name, kind: 'file' as const, size: 1 }, storageId: 'main', folderPath: 'Docs' }) as SearchHit;
    store.seed([
      {
        id: 'm2',
        role: 'assistant',
        text: 'The list is in the report.',
        at: '2026-07-01T10:00:01Z',
        reports: [{ title: 'Q1 files', rows: [row('main://Docs/a.pdf', 'a.pdf'), row('main://Docs/b.pdf', 'b.pdf')] }],
      },
    ]);
    await nextTick();

    expect(wrapper.text()).toContain('Q1 files');
    expect(wrapper.text()).toContain('2 files');
    // The rows themselves stay off the panel: that is what the card is for.
    expect(wrapper.text()).not.toContain('main://Docs/a.pdf');

    const buttons = () => wrapper.findAll('button');
    await buttons().find((b) => b.text() === 'Download as text')!.trigger('click');
    await buttons().find((b) => b.text() === 'Download as CSV')!.trigger('click');
    expect(saved).toEqual([
      { name: 'Q1 files.txt', type: 'text/plain;charset=utf-8' },
      { name: 'Q1 files.csv', type: 'text/csv;charset=utf-8' },
    ]);
  });

  it('draws a card that was refused, or that nobody answered, as such', async () => {
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.seed([
      {
        id: 'm2',
        role: 'assistant',
        text: 'Two files.',
        at: '2026-07-01T10:00:01Z',
        cards: [
          { kind: 'approval', path: 'main://Docs/a.csv', decision: 'denied' },
          { kind: 'approval', path: 'main://Docs/b.csv', decision: 'expired' },
        ],
      },
    ]);
    await nextTick();
    expect(wrapper.text()).toContain('You did not allow this file');
    expect(wrapper.text()).toContain('No answer came, so the assistant went on without it');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Allow this file')).toBe(false);
  });

  // The intro is the empty log's placeholder, not a heading over the conversation.
  it('shows the intro only while the log is empty', async () => {
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    expect(wrapper.text()).toContain('Find files by content, filename, or tags.');
    store.seed([{ id: 'a', role: 'user', text: 'q', at: '2026-07-10T10:24:00' }]);
    await nextTick();
    expect(wrapper.text()).not.toContain('Find files by content, filename, or tags.');
  });

  it('says on each mode chip what it does to the search', async () => {
    const { wrapper } = await setup();
    cleanup = () => wrapper.unmount();
    expect(radios(wrapper).map((r) => r.attributes('title'))).toEqual([
      'Search file and folder names only',
      'Search the text inside files as well as names',
      'Every word is a tag: find files tagged with it',
    ]);
  });

  it('shows a plan item by item before anything happens, and reports what actually did', async () => {
    script = [{ type: 'done' }];
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.sessionId = 's1';
    store.seed([
      { id: 'm1', role: 'user', text: 'tag the invoices', at: '2026-07-01T10:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        text: 'I have proposed tagging them.',
        at: '2026-07-01T10:00:01Z',
        cards: [
          {
            kind: 'plan',
            id: '7',
            planKind: 'tags',
            summary: 'Tag two invoices',
            status: 'pending',
            items: [
              { path: 'main://Docs/a.pdf', action: 'tag', args: { tags: 'invoices' }, size: 12000 },
              { path: 'main://Docs/b.pdf', action: 'tag', args: { tags: 'invoices' } },
            ],
          },
        ],
      },
    ]);
    await nextTick();

    // Every item is on screen, name and folder: a plan is approved by reading it.
    expect(wrapper.text()).toContain('Tag two invoices');
    expect(wrapper.text()).toContain('a.pdf');
    expect(wrapper.text()).toContain('b.pdf');
    expect(wrapper.text()).toContain('main://Docs');
    // The action is written in the reader's language from a code, not echoed from the server.
    expect(wrapper.text()).toContain('tag as invoices');
    expect(decisions).toHaveLength(0);

    // The same plan as text, with full addresses, for wherever it is pasted.
    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText: clipboard } });
    await wrapper.find('button[aria-label="Copy the plan"]').trigger('click');
    await flushPromises();
    expect(clipboard).toHaveBeenCalledWith('Tag two invoices\nmain://Docs/a.pdf — tag as invoices\nmain://Docs/b.pdf — tag as invoices');
    vi.unstubAllGlobals();

    await wrapper.findAll('button').find((b) => b.text() === 'Approve and run')!.trigger('click');
    await flushPromises();
    await nextTick();

    expect(decisions).toEqual([{ id: 's1', planId: '7', approve: true }]);
    // The outcome is per item, in the reader's language, not the server's English.
    expect(wrapper.text()).toContain('it had changed since the plan was made');
    expect(calls.at(-1)?.prompt).toBe('I approved the plan. 0 done, 1 not done.');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Approve and run')).toBe(false);
  });

  // A share plan is the one kind that HANDS SOMETHING BACK. The link is the
  // whole reason the person approved it, so a result that only says "done" is
  // a result they cannot use.
  it('prints the link a share plan minted, and says what approving one means before they do', async () => {
    script = [{ type: 'done' }];
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.sessionId = 's1';
    store.seed([
      { id: 'm1', role: 'user', text: 'give me a link to the report', at: '2026-07-01T10:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        text: 'I have proposed a public link.',
        at: '2026-07-01T10:00:01Z',
        cards: [
          {
            kind: 'plan',
            id: '9',
            planKind: 'create_share',
            summary: 'Create a public link to the report',
            status: 'pending',
            items: [{ path: 'main://Docs/report.pdf', action: 'create_share', args: { existing: '1' }, size: 12000 }],
          },
        ],
      },
    ]);
    await nextTick();

    // While it is still a proposal: what approving it means, in the reader's language and from the code — never
    // echoed from the server — and that the file already has a link, so a second one is a decision, not an accident.
    expect(wrapper.text()).toContain('anyone holding it can open this without signing in');
    expect(wrapper.text()).toContain('already has 1 link');

    // Once it has run, the items give way to what happened — and for this kind that includes the link itself.
    store.seed([
      { id: 'm1', role: 'user', text: 'give me a link to the report', at: '2026-07-01T10:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        text: 'Here is the link.',
        at: '2026-07-01T10:00:01Z',
        cards: [
          {
            kind: 'plan',
            id: '9',
            planKind: 'create_share',
            summary: 'Create a public link to the report',
            status: 'done',
            items: [{ path: 'main://Docs/report.pdf', action: 'create_share', args: { existing: '1' }, size: 12000 }],
            results: [{ path: 'main://Docs/report.pdf', state: 'done', url: 'https://filex.test/s/abc123' }],
          },
        ],
      },
    ]);
    await nextTick();
    expect(wrapper.text()).toContain('https://filex.test/s/abc123');

    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
    await wrapper.findAll('button').find((b) => b.text() === 'Copy link')!.trigger('click');
    await flushPromises();
    expect(clipboard).toHaveBeenCalledWith('https://filex.test/s/abc123');
    vi.unstubAllGlobals();
  });
  it('opens the plan in a modal with the same list and decides it from there', async () => {
    script = [{ type: 'done' }];
    decisions.length = 0;
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.sessionId = 's1';
    store.seed([
      {
        id: 'm1',
        role: 'assistant',
        text: 'Proposed.',
        at: '2026-07-01T10:00:00Z',
        cards: [
          {
            kind: 'plan',
            id: '7',
            planKind: 'move',
            summary: 'Move the photos',
            status: 'pending',
            items: Array.from({ length: 40 }, (_, i) => ({ path: `main://Photos/p${i}.webp`, action: 'move', args: { target: 'main://webp' } })),
          },
        ],
      },
    ]);
    await nextTick();

    await wrapper.find('button[aria-label="Open the plan in full"]').trigger('click');
    await nextTick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Move the photos');
    expect(dialog?.textContent).toContain('p39.webp');
    expect(dialog?.textContent).toContain('main://Photos');
    expect(dialog?.textContent).toContain('move to main://webp');

    const approve = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Approve and run') as HTMLButtonElement;
    approve.click();
    await flushPromises();
    await nextTick();
    expect(decisions).toEqual([{ id: 's1', planId: '7', approve: true }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
