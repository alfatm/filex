import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantEvent, AssistantMode, SearchHit } from '@/data/types';
import { useAssistantStore } from './assistantStore';

const calls: { prompt: string; mode: AssistantMode; conversationId: string | null; signal: AbortSignal }[] = [];
let script: AssistantEvent[] = [];
/** When set, the generator throws this instead of yielding once the script is exhausted. */
let failWith: Error | null = null;
/** Resolves once per event so the test can observe the store between events. */
let release: (() => void) | null = null;
const gate = () => new Promise<void>((resolve) => (release = resolve));

vi.mock('@/data', () => ({
  repository: {
    async *assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal) {
      calls.push({ prompt, mode, conversationId, signal });
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
    release = null;
    failWith = null;
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

  it('passes the selected mode and echoes the conversation id from the meta event', async () => {
    script = [{ type: 'meta', conversationId: 'conv-7' }, { type: 'done' }];
    const store = useAssistantStore();
    store.mode = 'tags';
    let turn = store.send('x');
    await step();
    await step();
    await turn;
    expect(calls[0]).toMatchObject({ mode: 'tags', conversationId: null });
    expect(store.conversationId).toBe('conv-7');
    turn = store.send('y');
    await step();
    await step();
    await turn;
    expect(calls[1].conversationId).toBe('conv-7');
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
});
