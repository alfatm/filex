import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { repository } from '@/data';
import type { ApprovalCard, AssistantCard, AssistantContext, AssistantMessage, AssistantMode, AssistantSession, PlanCard, PlanOutcome } from '@/data/types';

export const ASSISTANT_MODES: AssistantMode[] = ['filename', 'content', 'tags'];

/** Mirrors `model.MaxAssistantSessions`: shown in the list so the eviction rule is stated, not discovered. */
export const MAX_ASSISTANT_SESSIONS = 100;

/** The last conversation on screen, so a reload or a new tab comes back to it rather than to an empty chat. */
const STORAGE_KEY = 'filex.app.assistant.session';

function storedSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export const useAssistantStore = defineStore('assistant', () => {
  const messages = ref<AssistantMessage[]>([]);
  /** The account's conversations, most recently active first. Loaded when the panel opens. */
  const sessions = ref<AssistantSession[]>([]);
  /** The conversation on screen; null until one is started or opened. */
  const sessionId = ref<string | null>(null);
  const mode = ref<AssistantMode>('filename');
  const streaming = ref(false);
  /** The files this conversation may open. One path per approval — there is no wildcard here or on the server. */
  const granted = ref<string[]>([]);
  /** What the assistant is doing right now, while it is doing it: `{ tool, target }`, or null between tools. */
  const activity = ref<{ tool: string; target?: string } | null>(null);
  let controller: AbortController | null = null;
  let seq = 0;

  watch(sessionId, (id) => {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable — the conversation is simply not remembered across reloads
    }
  });

  function push(role: AssistantMessage['role'], text: string): AssistantMessage {
    const message: AssistantMessage = { id: `m${++seq}`, role, text, at: new Date().toISOString() };
    messages.value.push(message);
    return message;
  }

  /**
   * Sends `text` and streams the reply into the message list; one turn at a time. `context` is what the person has
   * on screen as they ask — it travels with this question only, the way the mode chip does.
   *
   * A conversation is opened first if there is none: the question and the answer are both stored server-side, and a
   * turn with nowhere to be written is a turn that vanishes when the panel closes.
   */
  async function send(text: string, context?: AssistantContext) {
    const prompt = text.trim();
    if (!prompt || streaming.value) return;
    // The question goes on screen before anything is awaited: it is already typed, and watching it hang in the box
    // while a session is created would be the app pretending not to have it.
    push('user', prompt);
    streaming.value = true;
    const own = new AbortController();
    controller = own;
    // The assistant message the next `text` / `hits` event appends to; `done` closes it.
    let current: AssistantMessage | null = null;
    try {
      // Created inline rather than through newSession(), which clears the log — the question just pushed is in it.
      if (!sessionId.value) sessionId.value = (await repository.createAssistantSession()).id;
      for await (const event of repository.assistantAsk(prompt, mode.value, sessionId.value, own.signal, context)) {
        if (own.signal.aborted) break;
        // `meta` names the conversation the server wrote the turn into; it is the session already on screen.
        if (event.type === 'meta') continue;
        if (event.type === 'done') {
          current = null;
          continue;
        }
        // The server named the conversation. It is not part of the answer either — it belongs to the chat list.
        if (event.type === 'title') {
          applyTitle(sessionId.value, event.title);
          continue;
        }
        // A tool is not part of the answer; it is what is happening before the answer.
        if (event.type === 'tool') {
          activity.value = { tool: event.tool, target: event.target };
          continue;
        }
        current ??= push('assistant', '');
        if (event.type === 'text') {
          activity.value = null;
          current.text += event.delta;
        } else if (event.type === 'hits') current.hits = [...(current.hits ?? []), ...event.hits];
        else if (event.type === 'card') current.cards = [...(current.cards ?? []), event.card];
        // The model call failed part-way. What arrived stays: it is what the reader already read.
        else current.error = true;
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
        activity.value = null;
      }
    }
  }

  /** Stops the in-flight turn (panel closed); the partial answer stays in the list, marked as stopped. */
  function abort() {
    if (!controller) return;
    controller.abort();
    controller = null;
    streaming.value = false;
    activity.value = null;
    const last = messages.value.at(-1);
    if (last?.role === 'assistant' && last.text) last.aborted = true;
  }

  /**
   * Renames a conversation in the list. The first question of a brand-new conversation is asked before the list
   * knows about it — it is created inline — so a name for a row that is not there yet reloads the list instead.
   */
  function applyTitle(id: string | null, title: string) {
    if (!id) return;
    const at = sessions.value.findIndex((s) => s.id === id);
    if (at >= 0) sessions.value[at] = { ...sessions.value[at], title };
    else void loadSessions();
  }

  async function loadSessions() {
    sessions.value = await repository.listAssistantSessions();
  }

  /** Starts a conversation and shows it empty. Reaching the cap evicts, so the list is reloaded from the answer. */
  async function newSession() {
    abort();
    const session = await repository.createAssistantSession();
    messages.value = [];
    granted.value = [];
    sessionId.value = session.id;
    await loadSessions();
    return session;
  }

  /** Opens a stored conversation: its messages come from the server, which is the only place they live. */
  async function openSession(id: string) {
    abort();
    sessionId.value = id;
    const conversation = await repository.assistantMessages(id);
    messages.value = conversation.messages;
    granted.value = conversation.granted;
    seq = messages.value.length;
  }

  /**
   * Reopens the conversation the last panel showed, once per page: a panel that already has one keeps it. A
   * conversation that cannot be opened — deleted from another tab, evicted by the cap — is forgotten rather than
   * retried on every mount.
   */
  async function restore() {
    const id = storedSessionId();
    if (sessionId.value || !id) return;
    try {
      await openSession(id);
    } catch {
      sessionId.value = null;
      messages.value = [];
      granted.value = [];
    }
  }

  async function renameSession(id: string, title: string) {
    const updated = await repository.renameAssistantSession(id, title);
    const at = sessions.value.findIndex((s) => s.id === id);
    if (at >= 0) sessions.value[at] = updated;
  }

  /** Hard delete, as on the server: a chat log the person removed leaves no copy behind. */
  async function removeSession(id: string) {
    await repository.deleteAssistantSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (sessionId.value === id) {
      sessionId.value = null;
      messages.value = [];
      granted.value = [];
    }
  }

  /**
   * Records permission to read ONE file, for this conversation only. The caller then says so in the chat, because
   * everything the assistant is told has to be visible in the conversation — including a permission.
   */
  async function approveRead(path: string) {
    if (!sessionId.value || granted.value.includes(path)) return;
    await repository.approveAssistantRead(sessionId.value, path);
    granted.value = [...granted.value, path];
  }

  /** Whether a card has already been answered, so a reopened chat does not ask twice. */
  function isGranted(card: ApprovalCard) {
    return granted.value.includes(card.path);
  }

  /**
   * Runs a plan the person approved, or drops it.
   *
   * The request carries no work — the plan is already stored, resolved and fingerprinted, and the server executes
   * that. What comes back is what actually happened, which is written onto the card so the person sees per item
   * whether it was done, skipped or failed.
   */
  async function decidePlan(card: PlanCard, approve: boolean): Promise<PlanOutcome | null> {
    if (!sessionId.value || card.status !== 'pending') return null;
    const outcome = await repository.decideAssistantPlan(sessionId.value, card.id, approve);
    card.status = outcome.status;
    if (outcome.results.length) card.results = outcome.results;
    return outcome;
  }

  /** Narrowing helper, so a template does not have to know the union's shape. */
  function isPlan(card: AssistantCard): card is PlanCard {
    return card.kind === 'plan';
  }

  /** Screenshot / e2e fixture: replaces the conversation without streaming. */
  function seed(list: AssistantMessage[]) {
    abort();
    messages.value = list;
    seq = list.length;
  }

  return {
    messages,
    sessions,
    sessionId,
    mode,
    streaming,
    granted,
    activity,
    send,
    approveRead,
    isGranted,
    decidePlan,
    isPlan,
    abort,
    seed,
    loadSessions,
    newSession,
    openSession,
    restore,
    renameSession,
    removeSession,
  };
});
