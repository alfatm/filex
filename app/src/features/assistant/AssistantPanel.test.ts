import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantEvent, AssistantMode } from '@/data/types';
import { i18n } from '@/i18n';
import AssistantPanel from './AssistantPanel.vue';
import { useAssistantStore } from './assistantStore';

const calls: { prompt: string; mode: AssistantMode }[] = [];
const approvals: { id: string; path: string }[] = [];
let script: AssistantEvent[] = [];
let release: (() => void) | null = null;

vi.mock('@/data', () => ({
  repository: {
    async listStorages() {
      return [];
    },
    async currentUser() {
      return { id: 'demo', name: 'demo', initial: 'D' };
    },
    async createAssistantSession() {
      return { id: 's1', title: '', titleManual: false, messageCount: 0, lastActiveAt: '', createdAt: '' };
    },
    async approveAssistantRead(id: string, path: string) {
      approvals.push({ id, path });
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

  it('renders the error and stopped hints', async () => {
    const { wrapper, store } = await setup();
    cleanup = () => wrapper.unmount();
    store.seed([
      { id: 'a', role: 'user', text: 'q', at: '2026-07-10T10:24:00' },
      { id: 'b', role: 'assistant', text: 'partial', at: '2026-07-10T10:24:00', aborted: true },
      { id: 'c', role: 'assistant', text: '', at: '2026-07-10T10:24:00', error: true },
    ]);
    await nextTick();
    expect(wrapper.text()).toContain('Stopped');
    expect(wrapper.text()).toContain('Something went wrong. Please try again.');
  });

  it('asks for one file at a time, and says the permission out loud in the chat', async () => {
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

    const allow = wrapper.findAll('button').find((b) => b.text() === 'Allow this file');
    await allow!.trigger('click');
    await flushPromises();
    // The grant is recorded for that one path, and the conversation records that it was given.
    expect(approvals).toEqual([{ id: 's1', path: 'main://Docs/pay.csv' }]);
    expect(calls.at(-1)?.prompt).toBe('You may read `main://Docs/pay.csv`.');
    await nextTick();
    expect(wrapper.text()).toContain('You allowed this file');
  });
});
