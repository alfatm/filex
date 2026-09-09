import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalCard, AssistantContext, AssistantEvent, AssistantMode, AssistantSession, PlanCard, SearchHit } from '@/data/types';
import { useAssistantStore } from './assistantStore';

const calls: { prompt: string; mode: AssistantMode; conversationId: string | null; signal: AbortSignal; context?: AssistantContext }[] = [];
const approvals: { id: string; path: string }[] = [];
const decisions: { id: string; planId: string; approve: boolean }[] = [];
let script: AssistantEvent[] = [];
/** When set, the generator throws this instead of yielding once the script is exhausted. */
let failWith: Error | null = null;
/** Resolves once per event so the test can observe the store between events. */
let release: (() => void) | null = null;
/** What `listAssistantSessions` answers, for the reload path a brand-new conversation takes. */
let sessionRows: AssistantSession[] = [];
/** When set, `assistantMessages` rejects with it: the stored conversation is gone. */
let messagesFailWith: Error | null = null;
const gate = () => new Promise<void>((resolve) => (release = resolve));

// happy-dom exposes no localStorage here; the store only needs getItem/setItem/removeItem.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
  removeItem: (key: string) => backing.delete(key),
});
const SESSION_KEY = 'filex.app.assistant.session';

vi.mock('@/data', () => ({
  repository: {
    // A turn is written into a stored conversation, so one is opened on the first question.
    createAssistantSession: async () => ({ id: 's1', title: '', titleManual: false, messageCount: 0, lastActiveAt: '', createdAt: '' }),
    listAssistantSessions: async () => sessionRows.map((s) => ({ ...s })),
    deleteAssistantSession: async () => {},
    assistantMessages: async () => {
      if (messagesFailWith) throw messagesFailWith;
      return { messages: [{ id: 'm1', role: 'assistant', text: 'earlier', at: '', cards: [{ kind: 'approval', path: 'main://pay.csv' }] }], granted: ['main://pay.csv'] };
    },
    approveAssistantRead: async (id: string, path: string) => {
      approvals.push({ id, path });
    },
    decideAssistantPlan: async (id: string, planId: string, approve: boolean) => {
      decisions.push({ id, planId, approve });
      return approve
        ? { status: 'done' as const, results: [{ path: 'main://Docs/a.pdf', state: 'done' as const }], done: 1, skipped: 0, failed: 0 }
        : { status: 'cancelled' as const, results: [], done: 0, skipped: 0, failed: 0 };
    },
    async *assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal, context?: AssistantContext) {
      calls.push({ prompt, mode, conversationId, signal, context });
      for (const event of script) {
        await gate();
        yield event;
      }
      if (failWith) {
        await gate();
        throw failWith;
      }
    },
  },
}));

const hit = { node: { id: 'readme-md', name: 'README.md' }, storageId: 'demo', folderPath: '' } as SearchHit;
const hit2 = { node: { id: 'app-ts', name: 'app.ts' }, storageId: 'demo', folderPath: '' } as SearchHit;

/** Lets the generator reach its gate, opens it, and waits until the store has processed the event. */
async function step() {
  await vi.waitFor(() => expect(release).not.toBeNull());
  const open = release!;
  release = null;
  open();
  await vi.waitFor(() => expect(release).toBeNull());
  await Promise.resolve();
}

describe('assistant store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    calls.length = 0;
    approvals.length = 0;
    decisions.length = 0;
    release = null;
    failWith = null;
    messagesFailWith = null;
    sessionRows = [];
    backing.clear();
  });

  it('remembers the conversation on screen and forgets it when it is removed', async () => {
    const store = useAssistantStore();
    await store.openSession('s9');
    await nextTick();
    expect(backing.get(SESSION_KEY)).toBe('s9');
    await store.removeSession('s9');
    await nextTick();
    expect(backing.has(SESSION_KEY)).toBe(false);
  });

  it('restores the remembered conversation once, never over one already on screen', async () => {
    backing.set(SESSION_KEY, 's9');
    const store = useAssistantStore();
    await store.restore();
    expect([store.sessionId, store.messages[0]?.text, store.granted]).toEqual(['s9', 'earlier', ['main://pay.csv']]);

    store.sessionId = 's1';
    store.messages = [];
    await store.restore();
    expect([store.sessionId, store.messages]).toEqual(['s1', []]);
  });

  it('does nothing without a remembered conversation', async () => {
    const store = useAssistantStore();
    await store.restore();
    expect([store.sessionId, store.messages]).toEqual([null, []]);
  });

  it('forgets a remembered conversation that can no longer be opened', async () => {
    backing.set(SESSION_KEY, 's9');
    messagesFailWith = new Error('not found');
    const store = useAssistantStore();
    await store.restore();
    await nextTick();
    expect([store.sessionId, store.messages, store.granted]).toEqual([null, [], []]);
    expect(backing.has(SESSION_KEY)).toBe(false);
  });

  it('streams text into one assistant message, attaches hits, and starts a new message after done', async () => {
    script = [
      { type: 'text', delta: 'I found ' },
      { type: 'text', delta: '1 file.' },
      { type: 'hits', hits: [hit] },
      { type: 'done' },
      { type: 'text', delta: 'Anything else?' },
      { type: 'done' },
    ];
    const store = useAssistantStore();
    const turn = store.send('  hello  ');
    expect(store.streaming).toBe(true);
    expect(store.messages.map((m) => [m.role, m.text])).toEqual([['user', 'hello']]);

    await step();
    expect(store.messages[1].text).toBe('I found ');
    await step();
    expect(store.messages[1].text).toBe('I found 1 file.');
    expect(store.messages[1].hits).toBeUndefined();
    await step();
    expect(store.messages[1].hits).toEqual([hit]);
    await step();
    await step();
    expect(store.messages).toHaveLength(3);
    expect(store.messages[2]).toMatchObject({ role: 'assistant', text: 'Anything else?' });
    await step();
    await turn;
    expect(store.streaming).toBe(false);
    expect(calls[0].prompt).toBe('hello');
  });

  it('hands what is on screen to the repository with the question', async () => {
    script = [{ type: 'done' }];
    const store = useAssistantStore();
    const context: AssistantContext = { page: 'folder', folder: 'main://Docs', selected: ['main://Docs/a.pdf'] };
    const turn = store.send('what is this?', context);
    await step();
    await turn;
    expect(calls[0]).toMatchObject({ prompt: 'what is this?', context });
  });

  it('appends a second hits event to the cards already attached', async () => {
    script = [
      { type: 'hits', hits: [hit] },
      { type: 'hits', hits: [hit2] },
    ];
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    await step();
    await turn;
    expect(store.messages[1].hits).toEqual([hit, hit2]);
  });

  it('opens a conversation for the first question and keeps every later turn in it', async () => {
    script = [{ type: 'meta', conversationId: 's1' }, { type: 'done' }];
    const store = useAssistantStore();
    store.mode = 'tags';
    let turn = store.send('x');
    await step();
    await step();
    await turn;
    expect(calls[0]).toMatchObject({ mode: 'tags', conversationId: 's1' });
    expect(store.sessionId).toBe('s1');
    turn = store.send('y');
    await step();
    await step();
    await turn;
    expect(calls[1].conversationId).toBe('s1');
  });

  it('marks the answer failed when the server reports the model call failed, and keeps what arrived', async () => {
    script = [
      { type: 'text', delta: 'half an ' },
      { type: 'error', message: 'provider returned 429' },
      { type: 'done' },
    ];
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    await step();
    await step();
    await turn;
    expect(store.messages[1]).toMatchObject({ text: 'half an ', error: true });
  });

  it('abort stops the stream, keeps the partial answer and marks it stopped', async () => {
    script = [
      { type: 'text', delta: 'partial' },
      { type: 'text', delta: ' never' },
    ];
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    expect(store.messages[1].text).toBe('partial');
    store.abort();
    expect(store.streaming).toBe(false);
    expect(calls[0].signal.aborted).toBe(true);
    expect(store.messages[1].aborted).toBe(true);
    await step();
    await turn;
    expect(store.messages[1].text).toBe('partial');
    expect(store.messages[1].error).toBeUndefined();
  });

  it('treats a rejection after abort as the normal way out, not an error', async () => {
    script = [{ type: 'text', delta: 'partial' }];
    failWith = new DOMException('The user aborted a request.', 'AbortError');
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    store.abort();
    await step();
    await turn;
    expect(store.messages[1]).toMatchObject({ text: 'partial', aborted: true });
    expect(store.messages[1].error).toBeUndefined();
    expect(store.streaming).toBe(false);
  });

  it('marks the open message as failed when the stream throws mid-way', async () => {
    script = [{ type: 'text', delta: 'partial' }];
    failWith = new Error('boom');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    await step();
    await turn;
    expect(store.messages[1]).toMatchObject({ role: 'assistant', text: 'partial', error: true });
    expect(store.streaming).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // A failure before the first word still leaves a message to hang the error line on.
    script = [];
    const again = store.send('y');
    await step();
    await again;
    expect(store.messages[3]).toMatchObject({ role: 'assistant', text: '', error: true });
    expect(store.streaming).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it('seed aborts the in-flight turn and replaces the conversation', async () => {
    script = [
      { type: 'text', delta: 'partial' },
      { type: 'text', delta: ' never' },
    ];
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    store.seed([{ id: 's1', role: 'user', text: 'seeded', at: '2026-07-10T10:24:00' }]);
    expect(calls[0].signal.aborted).toBe(true);
    expect(store.streaming).toBe(false);
    await step();
    await turn;
    expect(store.messages.map((m) => m.text)).toEqual(['seeded']);
    expect(store.streaming).toBe(false);
  });

  it('ignores empty prompts and a second send while streaming', async () => {
    script = [{ type: 'done' }];
    const store = useAssistantStore();
    await store.send('   ');
    expect(store.messages).toHaveLength(0);
    const turn = store.send('one');
    await store.send('two');
    expect(store.messages.map((m) => m.text)).toEqual(['one']);
    await step();
    await turn;
    expect(calls).toHaveLength(1);
  });

  it('shows what the assistant is doing while it does it, and stops showing it once words arrive', async () => {
    script = [
      { type: 'tool', tool: 'list_folder', target: 'main://Docs' },
      { type: 'text', delta: 'Two files.' },
      { type: 'done' },
    ];
    const store = useAssistantStore();
    const turn = store.send('what is in Docs?');
    await step();
    // A tool is not part of the answer — no empty bubble appears for it.
    expect(store.activity).toEqual({ tool: 'list_folder', target: 'main://Docs' });
    expect(store.messages).toHaveLength(1);
    await step();
    expect(store.activity).toBeNull();
    expect(store.messages[1].text).toBe('Two files.');
    await step();
    await turn;
    expect(store.activity).toBeNull();
  });

  it('attaches a permission request to the turn that raised it, and records the answer for that file only', async () => {
    script = [
      { type: 'text', delta: 'I need the pay file.' },
      { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' } },
      { type: 'done' },
    ];
    const store = useAssistantStore();
    const turn = store.send('summarise pay');
    await step();
    await step();
    await step();
    await turn;

    const card = store.messages[1].cards?.[0] as ApprovalCard;
    expect(card).toMatchObject({ path: 'main://Docs/pay.csv', reason: 'to total the salaries' });
    expect(store.isGranted(card)).toBe(false);

    await store.approveRead('main://Docs/pay.csv');
    expect(approvals).toEqual([{ id: 's1', path: 'main://Docs/pay.csv' }]);
    expect(store.isGranted(card)).toBe(true);
    // Approving one file says nothing about the next one.
    expect(store.isGranted({ kind: 'approval', path: 'main://Docs/other.csv' })).toBe(false);

    // Approving twice does not ask the server twice.
    await store.approveRead('main://Docs/pay.csv');
    expect(approvals).toHaveLength(1);
  });

  it('reopens a conversation with its pending questions and the permissions already given', async () => {
    const store = useAssistantStore();
    await store.openSession('s9');
    expect((store.messages[0].cards?.[0] as ApprovalCard).path).toBe('main://pay.csv');
    expect(store.granted).toEqual(['main://pay.csv']);
    expect(store.isGranted({ kind: 'approval', path: 'main://pay.csv' })).toBe(true);
  });

  it('runs a plan only once the person approves it, and writes the outcome onto the card', async () => {
    script = [
      { type: 'text', delta: 'I have proposed tagging them.' },
      {
        type: 'card',
        card: { kind: 'plan', id: '7', planKind: 'tags', summary: 'Tag the invoices', status: 'pending', items: [{ path: 'main://Docs/a.pdf', action: 'tag as invoices' }] },
      },
      { type: 'done' },
    ];
    const store = useAssistantStore();
    const turn = store.send('tag the invoices');
    await step();
    await step();
    await step();
    await turn;

    const card = store.messages[1].cards?.[0] as PlanCard;
    expect(card).toMatchObject({ kind: 'plan', id: '7', status: 'pending' });
    expect(store.isPlan(card)).toBe(true);
    // Proposing changes nothing on its own: no call has been made.
    expect(decisions).toHaveLength(0);

    const outcome = await store.decidePlan(card, true);
    expect(decisions).toEqual([{ id: 's1', planId: '7', approve: true }]);
    expect(outcome?.done).toBe(1);
    expect(card.status).toBe('done');
    expect(card.results).toEqual([{ path: 'main://Docs/a.pdf', state: 'done' }]);

    // A decided plan is not asked again, however many times the button is pressed.
    expect(await store.decidePlan(card, true)).toBeNull();
    expect(decisions).toHaveLength(1);
  });

  it('refusing a plan runs nothing and marks it refused', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    const card: PlanCard = { kind: 'plan', id: '9', planKind: 'empty_trash', summary: 'Empty the trash', status: 'pending', items: [] };
    store.seed([{ id: 'm1', role: 'assistant', text: 'Proposed.', at: '', cards: [card] }]);
    const outcome = await store.decidePlan(card, false);
    expect(outcome?.status).toBe('cancelled');
    expect(card.status).toBe('cancelled');
    expect(decisions).toEqual([{ id: 's1', planId: '9', approve: false }]);
  });

  // The name comes down the same stream as the answer, so the chat list is right without refetching it.
  it('renames the conversation in the list when the server names it', async () => {
    const store = useAssistantStore();
    store.sessions = [{ id: 's1', title: '', titleManual: false, messageCount: 1, lastActiveAt: '', createdAt: '' }];
    script = [{ type: 'text', delta: 'Four.' }, { type: 'title', title: 'Counting the files' }, { type: 'done' }];
    const turn = store.send('how many files?');
    await step();
    await step();
    await step();
    await turn;
    expect(store.sessions[0].title).toBe('Counting the files');
    // A name is not part of the answer: it must not land in the bubble.
    expect(store.messages.at(-1)?.text).toBe('Four.');
  });

  // The first question of a conversation is asked before the list has heard of it.
  it('reloads the list when the named conversation is not in it yet', async () => {
    const store = useAssistantStore();
    sessionRows = [{ id: 's1', title: 'Counting the files', titleManual: false, messageCount: 2, lastActiveAt: '', createdAt: '' }];
    script = [{ type: 'text', delta: 'Four.' }, { type: 'title', title: 'Counting the files' }, { type: 'done' }];
    const turn = store.send('how many files?');
    await step();
    await step();
    await step();
    await turn;
    await vi.waitFor(() => expect(store.sessions.map((s) => s.title)).toEqual(['Counting the files']));
  });

});
