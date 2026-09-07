import { defineStore } from 'pinia';
import { ref } from 'vue';
import { repository } from '@/data';
import type { AssistantMessage, AssistantMode } from '@/data/types';

export const ASSISTANT_MODES: AssistantMode[] = ['filename', 'content', 'tags'];

export const useAssistantStore = defineStore('assistant', () => {
  const messages = ref<AssistantMessage[]>([]);
  const mode = ref<AssistantMode>('filename');
  const streaming = ref(false);
  /** From the last `meta` event; sent back on the next turn so the backend keeps the context. */
  const conversationId = ref<string | null>(null);
  let controller: AbortController | null = null;
  let seq = 0;

  function push(role: AssistantMessage['role'], text: string): AssistantMessage {
    const message: AssistantMessage = { id: `m${++seq}`, role, text, at: new Date().toISOString() };
    messages.value.push(message);
    return message;
  }

  /** Sends `text` and streams the reply into the message list; one turn at a time. */
  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || streaming.value) return;
    push('user', prompt);
    streaming.value = true;
    const own = new AbortController();
    controller = own;
    // The assistant message the next `text` / `hits` event appends to; `done` closes it.
    let current: AssistantMessage | null = null;
    try {
      for await (const event of repository.assistantAsk(prompt, mode.value, conversationId.value, own.signal)) {
        if (own.signal.aborted) break;
        if (event.type === 'meta') {
          conversationId.value = event.conversationId;
          continue;
        }
        if (event.type === 'done') {
          current = null;
          continue;
        }
        current ??= push('assistant', '');
        if (event.type === 'text') current.text += event.delta;
        else current.hits = [...(current.hits ?? []), ...event.hits];
      }
    } catch (error) {
      // A fetch rejects with AbortError after abort(); that is the expected way out, not a failure.
      if (!own.signal.aborted) {
        (current ?? push('assistant', '')).error = true;
        console.error('assistant stream failed', error);
      }
    } finally {
      if (controller === own) {
        controller = null;
        streaming.value = false;
      }
    }
  }

  /** Stops the in-flight turn (panel closed); the partial answer stays in the list, marked as stopped. */
  function abort() {
    if (!controller) return;
    controller.abort();
    controller = null;
    streaming.value = false;
    const last = messages.value.at(-1);
    if (last?.role === 'assistant' && last.text) last.aborted = true;
  }

  /** Screenshot / e2e fixture: replaces the conversation without streaming. */
  function seed(list: AssistantMessage[]) {
    abort();
    messages.value = list;
    seq = list.length;
  }

  return { messages, mode, streaming, conversationId, send, abort, seed };
});
