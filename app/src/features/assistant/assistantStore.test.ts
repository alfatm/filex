import { createPinia, setActivePinia } from 'pinia';
import { nextTick, watch } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalCard, AssistantCard, AssistantContext, AssistantEvent, AssistantMode, AssistantSession, PlanCard, SearchHit } from '@/data/types';
import { HttpError } from '@/data/http/client';
import { useSettingsStore } from '@/features/settings/settingsStore';
import { useAssistantStore } from './assistantStore';

const calls: { prompt: string; mode: AssistantMode; conversationId: string | null; signal: AbortSignal; context?: AssistantContext }[] = [];
const approvals: { id: string; path: string; allow: boolean }[] = [];
const decisions: { id: string; planId: string; approve: boolean }[] = [];
let script: AssistantEvent[] = [];
/** When set, the generator throws this instead of yielding once the script is exhausted. */
let failWith: Error | null = null;
/** Resolves once per event so the test can observe the store between events. */
let release: (() => void) | null = null;
/** What `listAssistantSessions` answers, for the reload path a brand-new conversation takes. */
let sessionRows: AssistantSession[] = [];
/** The cap this server states — the panel prints it, and it is not filex's default on every install. */
let sessionMax = 100;
/** When set, `assistantMessages` rejects with it: the stored conversation is gone. */
let messagesFailWith: Error | null = null;
/** Per conversation: `assistantMessages` waits on this before answering, so two opens can answer out of order. */
let messagesHold: Record<string, Promise<void>> = {};
/** Per conversation: what its single stored message says, when a test has to tell two conversations apart. */
let messagesText: Record<string, string> = {};
/** What `assistantMessages` says the conversation's cards are; the resync after a refused decision reads them. */
let storedCards: AssistantCard[] | null = null;
/** When set, `decideAssistantPlan` / `decideAssistantRead` reject with it — the server refusing the decision (409, 404). */
let planFailWith: Error | null = null;
let readFailWith: Error | null = null;
/** When set, `decideAssistantPlan` waits on it before answering, so a second click lands mid-flight. */
let planHold: Promise<void> | null = null;
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
    assistantSessionMax: () => sessionMax,
    deleteAssistantSession: async () => {},
    assistantMessages: async (id: string) => {
      const hold = messagesHold[id];
      if (hold) await hold;
      if (messagesFailWith) throw messagesFailWith;
      return {
        messages: [{ id: 'm1', role: 'assistant', text: messagesText[id] ?? 'earlier', at: '', cards: storedCards ?? [{ kind: 'approval', path: 'main://pay.csv' }] }],
        granted: ['main://pay.csv'],
      };
    },
    decideAssistantRead: async (id: string, path: string, allow: boolean) => {
      approvals.push({ id, path, allow });
      if (readFailWith) throw readFailWith;
    },
    decideAssistantPlan: async (id: string, planId: string, approve: boolean) => {
      decisions.push({ id, planId, approve });
      if (planHold) await planHold;
      if (planFailWith) throw planFailWith;
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
    messagesHold = {};
    messagesText = {};
    storedCards = null;
    planFailWith = null;
    readFailWith = null;
    planHold = null;
    sessionMax = 100;
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

  // The panel watches the messages to redraw and to keep the log at its end. It saw none of this while the answer
  // was written onto the object `push` handed back rather than onto the element the list actually holds.
  it('streams every delta as a change anything watching the messages can see', async () => {
    script = [{ type: 'text', delta: 'one ' }, { type: 'text', delta: 'two' }, { type: 'hits', hits: [hit] }, { type: 'done' }];
    const store = useAssistantStore();
    const seen: string[] = [];
    watch(() => store.messages.map((m) => `${m.text.length}/${m.hits?.length ?? 0}`).join(), (shape) => seen.push(shape));

    const turn = store.send('hello');
    await nextTick();
    await step();
    await nextTick();
    await step();
    await nextTick();
    await step();
    await nextTick();
    await step();
    await turn;
    expect(seen).toEqual(['5/0', '5/0,4/0', '5/0,7/0', '5/0,7/1']);
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

  it('attaches a report to the open assistant message', async () => {
    const report = { title: 'Everything', rows: [hit, hit2] };
    script = [{ type: 'text', delta: 'The list is in the report.' }, { type: 'report', report }, { type: 'done' }];
    const store = useAssistantStore();
    const turn = store.send('list everything');
    await step();
    expect(store.messages[1].reports).toBeUndefined();
    await step();
    expect(store.messages[1].reports).toEqual([report]);
    await step();
    await turn;
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
    expect(store.messages[1]).toMatchObject({ text: 'half an ', error: 'failed' });
  });

  // Out of credit is not "try again": the answer is the same until an administrator acts, and the line says so.
  it('keeps the kind of failure the server names', async () => {
    script = [{ type: 'error', message: 'provider returned 429: insufficient_quota', code: 'quota' }, { type: 'done' }];
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    await step();
    await turn;
    expect(store.messages[1]).toMatchObject({ role: 'assistant', text: '', error: 'quota' });
  });

  it('reads a 503 as the assistant being gone, not as a hiccup', async () => {
    script = [];
    failWith = new HttpError(503, { error: 'no assistant is configured' }, 'no assistant is configured');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    await turn;
    expect(store.messages[1]).toMatchObject({ role: 'assistant', text: '', error: 'unavailable' });
    consoleError.mockRestore();
  });

  // A minute of silence is a hung connection: the server says what it is doing when it is doing something.
  it('drops a turn that says nothing for a minute, and says so rather than marking it stopped', async () => {
    vi.useFakeTimers();
    try {
      script = [{ type: 'text', delta: 'late' }];
      const store = useAssistantStore();
      const turn = store.send('x');
      await vi.waitFor(() => expect(release).not.toBeNull());
      expect(store.streaming).toBe(true);

      vi.advanceTimersByTime(59_000);
      expect(store.messages).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(store.messages[1]).toMatchObject({ role: 'assistant', text: '', error: 'timeout' });
      expect(calls[0].signal.aborted).toBe(true);

      // The word that arrives after the drop is not appended: the connection is closed.
      release!();
      await turn;
      expect(store.messages[1].text).toBe('');
      expect(store.messages[1].aborted).toBeUndefined();
      expect(store.streaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    expect(store.messages[1]).toMatchObject({ role: 'assistant', text: 'partial', error: 'failed' });
    expect(store.streaming).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // A failure before the first word still leaves a message to hang the error line on.
    script = [];
    const again = store.send('y');
    await step();
    await again;
    expect(store.messages[3]).toMatchObject({ role: 'assistant', text: '', error: 'failed' });
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

    await store.decideRead(card, true);
    expect(approvals).toEqual([{ id: 's1', path: 'main://Docs/pay.csv', allow: true }]);
    expect(card.decision).toBe('allowed');
    expect(store.isGranted(card)).toBe(true);
    // Nothing was typed into the chat for it: the answer went to the waiting turn, not to the model as a message.
    expect(calls).toHaveLength(1);
    // Approving one file says nothing about the next one.
    expect(store.isGranted({ kind: 'approval', path: 'main://Docs/other.csv' })).toBe(false);

    // A decided card is decided; pressing again asks the server nothing.
    await store.decideRead(card, false);
    expect(approvals).toHaveLength(1);
    expect(card.decision).toBe('allowed');
  });

  // The turn stands still at the card on the server, so a minute of silence there is the person thinking, not a
  // hung connection; and the card comes back down the same stream decided, closing the one that asked.
  it('holds the watchdog while a permission card is open, and closes the card the server sends back decided', async () => {
    vi.useFakeTimers();
    try {
      script = [
        { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' } },
        { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries', decision: 'denied' } },
        { type: 'text', delta: 'Fine without it.' },
        { type: 'done' },
      ];
      const store = useAssistantStore();
      const turn = store.send('summarise pay');
      await step();
      expect(store.awaiting).toBe('main://Docs/pay.csv');
      vi.advanceTimersByTime(120_000);
      expect(store.messages[1].error).toBeUndefined();
      expect(store.streaming).toBe(true);

      const card = store.messages[1].cards?.[0] as ApprovalCard;
      await store.decideRead(card, false);
      expect(store.awaiting).toBeNull();
      expect(card.decision).toBe('denied');

      // The decided card is the same card, not a second one.
      await step();
      expect(store.messages[1].cards).toHaveLength(1);
      await step();
      await step();
      await turn;
      expect(store.messages[1].text).toBe('Fine without it.');
      expect(store.messages[1].error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  /**
   * `card.status` only changes once the answer is back, so both halves of a double click used to see a pending
   * card and both posted; the second one came back 409 with nobody listening for it.
   */
  it('sends one request when a plan is approved twice in a row', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    const card: PlanCard = { kind: 'plan', id: '11', planKind: 'tags', summary: 'Tag them', status: 'pending', items: [] };
    let release!: () => void;
    planHold = new Promise<void>((resolve) => (release = resolve));

    const first = store.decidePlan(card, true);
    const second = store.decidePlan(card, true);
    expect(store.isDeciding(card)).toBe(true);
    expect(await second).toBeNull();

    release();
    await first;
    expect(decisions).toEqual([{ id: 's1', planId: '11', approve: true }]);
    expect(store.isDeciding(card)).toBe(false);
    expect(card.status).toBe('done');
  });

  // A card that goes on offering Approve after the server refused the decision is a card that lies about itself.
  it('re-reads a plan the server refused to decide, instead of leaving it pending', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    const card: PlanCard = { kind: 'plan', id: '12', planKind: 'tags', summary: 'Tag them', status: 'pending', items: [] };
    planFailWith = new HttpError(409, null, 'already decided');
    // What the other tab (or the other half of the double click) left on the server.
    storedCards = [{ kind: 'plan', id: '12', planKind: 'tags', summary: 'Tag them', status: 'done', items: [], results: [{ path: 'main://a.pdf', state: 'done' }] }];

    expect(await store.decidePlan(card, true)).toBeNull();
    expect(store.decisionErrorOf(card)).toBe('already decided');
    expect(card.status).toBe('done');
    expect(card.results).toEqual([{ path: 'main://a.pdf', state: 'done' }]);
    expect(store.isDeciding(card)).toBe(false);
  });

  // 404: the conversation was deleted in another tab, so there is nothing left to re-read either.
  it('closes a plan whose conversation is gone', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    const card: PlanCard = { kind: 'plan', id: '13', planKind: 'tags', summary: 'Tag them', status: 'pending', items: [] };
    planFailWith = new HttpError(404, null, 'no such conversation');
    messagesFailWith = new HttpError(404, null, 'no such conversation');

    expect(await store.decidePlan(card, false)).toBeNull();
    expect(card.status).toBe('cancelled');
    expect(store.decisionErrorOf(card)).toBe('no such conversation');
  });

  it('closes a permission card the server refused to answer', async () => {
    const store = useAssistantStore();
    store.sessionId = 's1';
    const card: ApprovalCard = { kind: 'approval', path: 'main://Docs/pay.csv' };
    readFailWith = new HttpError(409, null, 'already answered');
    storedCards = [{ kind: 'approval', path: 'main://Docs/pay.csv', decision: 'denied' }];

    await store.decideRead(card, true);
    expect(card.decision).toBe('denied');
    expect(store.decisionErrorOf(card)).toBe('already answered');
    expect(store.isDeciding(card)).toBe(false);
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

  /**
   * `sessionId` used to be set before the messages were asked for: a conversation that could not be read left the
   * id pointing at nothing with the previous conversation's messages under it, so the next question went nowhere.
   */
  it('keeps the conversation on screen when the one being opened cannot be read', async () => {
    const store = useAssistantStore();
    await store.openSession('s9');
    expect(store.sessionId).toBe('s9');

    messagesFailWith = new HttpError(404, null, 'no such conversation');
    await expect(store.openSession('s10')).rejects.toThrow('no such conversation');
    expect(store.sessionId).toBe('s9');
    expect(store.messages[0]?.text).toBe('earlier');
  });

  // Two clicks in the list, answered in the other order: the one chosen last is the one on screen.
  it('shows the conversation chosen last, whichever answer comes back first', async () => {
    const store = useAssistantStore();
    messagesText = { s1: 'first chat', s2: 'second chat' };
    let answerFirst!: () => void;
    messagesHold = { s1: new Promise<void>((resolve) => (answerFirst = resolve)) };

    const first = store.openSession('s1');
    const second = store.openSession('s2');
    await second;
    expect([store.sessionId, store.messages[0].text]).toEqual(['s2', 'second chat']);

    answerFirst();
    await first;
    expect([store.sessionId, store.messages[0].text]).toEqual(['s2', 'second chat']);
  });

  // Left running, it went on writing into a message list that is being thrown away, held the panel "generating"
  // with the box disabled, and had the server appending its answer to a conversation that no longer exists.
  it('stops the running turn when the conversation it belongs to is removed', async () => {
    script = [{ type: 'text', delta: 'half an ' }, { type: 'text', delta: 'answer' }];
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    expect([store.streaming, store.sessionId]).toEqual([true, 's1']);

    await store.removeSession('s1');
    expect(store.streaming).toBe(false);
    expect(calls[0].signal.aborted).toBe(true);
    expect([store.sessionId, store.messages]).toEqual([null, []]);

    // The word that was already on its way lands nowhere: the conversation it belonged to is gone.
    await step();
    await turn;
    expect(store.messages).toEqual([]);
    expect(store.streaming).toBe(false);
  });

  // Nothing on the wire identifies a request, so a file asked about twice in one turn is two cards with one path:
  // closing the first (already decided) one left live buttons on the question actually being asked.
  it('closes the card still waiting when the same file is asked about twice in one turn', async () => {
    script = [
      { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' } },
      { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries', decision: 'denied' } },
      { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to check one figure' } },
      { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to check one figure', decision: 'allowed' } },
      { type: 'done' },
    ];
    const store = useAssistantStore();
    const turn = store.send('summarise pay');
    for (let i = 0; i < 5; i++) await step();
    await turn;

    const cards = store.messages[1].cards as ApprovalCard[];
    expect(cards.map((c) => [c.reason, c.decision])).toEqual([
      ['to total the salaries', 'denied'],
      ['to check one figure', 'allowed'],
    ]);
    expect(store.awaiting).toBeNull();
  });

  // A 429 is two different situations, and the server says which in the body's `code`: the person's own other tab
  // is mid-answer, or this account has asked too often this minute. One sentence for both told half of them to
  // wait for an answer that was never coming.
  it.each([
    [{ error: 'assistant: a turn is already running', code: 'busy' }, 'answering'],
    [{ error: 'assistant: too many turns', code: 'rate_limited' }, 'rateLimited'],
    // A refusal the server could not classify carries no code, and gets the sentence that covers both.
    [{ error: 'assistant: too many turns' }, 'busy'],
  ])('tells the two 429s apart by the code in the body (%o)', async (body, expected) => {
    script = [];
    failWith = new HttpError(429, body, 'refused');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = useAssistantStore();
    const turn = store.send('x');
    await step();
    await turn;
    expect(store.messages[1]).toMatchObject({ role: 'assistant', text: '', error: expected });
    consoleError.mockRestore();
  });

  // "Default search mode" in the settings modal used to be written, stored and read by nobody: every conversation
  // started on filename whatever it said.
  it('starts a conversation in the mode the settings call the default', async () => {
    const settings = useSettingsStore();
    settings.apply({ ...settings.settings, assistantMode: 'tags' });
    const store = useAssistantStore();
    expect(store.mode).toBe('tags');

    // The chips are for this conversation only; the next one starts at the default again.
    store.mode = 'content';
    await store.newSession();
    expect(store.mode).toBe('tags');
  });

  // The cap is the server's; a constant here read 100 on an install that had set something else.
  it('takes the conversation cap from the server, as the listing states it', async () => {
    sessionMax = 12;
    const store = useAssistantStore();
    await store.loadSessions();
    expect(store.sessionMax).toBe(12);
  });

  // The card is not a licence to wait for ever: the server gives the person five minutes, and a connection that
  // dies silently while the card is up would otherwise leave the panel generating with the box disabled.
  it('keeps watching the connection while a permission card is open, on the longer watch', async () => {
    vi.useFakeTimers();
    try {
      script = [
        { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' } },
        { type: 'text', delta: 'never' },
      ];
      const store = useAssistantStore();
      const turn = store.send('summarise pay');
      await step();
      expect(store.awaiting).toBe('main://Docs/pay.csv');

      // The whole of the server's own wait for an answer: still the person's time to think.
      vi.advanceTimersByTime(5 * 60_000);
      expect(store.streaming).toBe(true);
      expect(store.messages[1].error).toBeUndefined();

      vi.advanceTimersByTime(60_001);
      expect(store.messages[1]).toMatchObject({ error: 'timeout' });
      expect(calls[0].signal.aborted).toBe(true);

      release!();
      await turn;
      expect(store.streaming).toBe(false);
      expect(store.awaiting).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
