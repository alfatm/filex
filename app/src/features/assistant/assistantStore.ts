import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { repository } from '@/data';
import { HttpError } from '@/data/http/client';
import { errorMessage } from '@/lib/errors';
import { useSettingsStore } from '@/features/settings/settingsStore';
import type { ApprovalCard, AssistantCard, AssistantContext, AssistantEvent, AssistantFailure, AssistantMessage, AssistantMode, AssistantSession, PlanCard, PlanOutcome } from '@/data/types';

export const ASSISTANT_MODES: AssistantMode[] = ['filename', 'content', 'tags'];

/** The last conversation on screen, so a reload or a new tab comes back to it rather than to an empty chat. */
const STORAGE_KEY = 'filex.app.assistant.session';

/**
 * How long the server may say nothing before the turn is given up on. A turn that is doing something says so — a
 * tool event, a word — so a minute of silence is a hung connection, not a slow answer, and a spinner that never stops
 * is worse than an error line.
 */
const SILENCE_MS = 60_000;

/**
 * The same watch while an approval card is open. The turn is standing at the card on the server, which waits five
 * minutes for the person before giving up (`approvalWait`), so silence there is expected — but not endless: a
 * connection that dies unnoticed while the card is up would otherwise leave the panel generating for ever.
 */
const APPROVAL_SILENCE_MS = 6 * 60_000;

function storedSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export const useAssistantStore = defineStore('assistant', () => {
  const settings = useSettingsStore();
  const messages = ref<AssistantMessage[]>([]);
  /** The account's conversations, most recently active first. Loaded when the panel opens. */
  const sessions = ref<AssistantSession[]>([]);
  /**
   * How many conversations this account may keep, as the server states it. Read from the repository rather than
   * held as a constant here: an install that changed the limit would otherwise be described by filex's default.
   */
  const sessionMax = ref(repository.assistantSessionMax());
  /** The conversation on screen; null until one is started or opened. */
  const sessionId = ref<string | null>(null);
  /** A conversation starts in the mode the settings modal calls the default; the chips change it from there. */
  const mode = ref<AssistantMode>(settings.settings.assistantMode);
  const streaming = ref(false);
  /** The files this conversation may open. One path per approval — there is no wildcard here or on the server. */
  const granted = ref<string[]>([]);
  /** What the assistant is doing right now, while it is doing it: `{ tool, target }`, or null between tools. */
  const activity = ref<{ tool: string; target?: string } | null>(null);
  /** The file the running turn is standing still for — an approval card with its buttons still on — or null. */
  const awaiting = ref<string | null>(null);
  /**
   * The cards whose decision is on its way to the server.
   *
   * Set BEFORE the request, which is the whole point: `card.status` and `card.decision` only change once the
   * answer is back, so two clicks in the same tick both saw a pending card and both posted — the second one
   * getting a 409 nobody was listening for.
   */
  const deciding = ref<string[]>([]);
  /** What the server said about the last refused decision, and which card it was about. */
  const decisionError = ref<{ card: string; message: string } | null>(null);
  let controller: AbortController | null = null;
  let seq = 0;
  // The silence watchdog of the running turn; `rearm` is null between turns.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let rearm: ((ms?: number) => void) | null = null;
  // The conversation being opened right now: only its own answer may reach the screen, and only while it is still
  // the one that was asked for.
  let opening: string | null = null;

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
    // The element as the LIST now holds it, not the object handed over: a ref stores what it is given raw, so the
    // streamed deltas, hits, cards and errors written onto the returned message afterwards changed nothing anyone
    // could see — the panel only caught up when some other ref happened to re-render it.
    return messages.value[messages.value.length - 1];
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
    await runTurn((session, signal) => repository.assistantAsk(prompt, mode.value, session, signal, context));
  }

  /**
   * Lets the assistant back in after a plan ran and left something undone. Nobody typed anything: the executor's
   * line is already the last thing in the conversation, and this streams the answer to it the same way a question
   * would. A plan that ran in full, or one the person refused, never gets here — there is nothing left to say.
   */
  async function resume() {
    if (streaming.value || !sessionId.value) return;
    await runTurn((session, signal) => repository.assistantResume(session, signal));
  }

  /** One turn on the wire, however it was started: the watchdog, the abort handling, and the events onto the log. */
  async function runTurn(open: (session: string, signal: AbortSignal) => AsyncIterable<AssistantEvent>) {
    streaming.value = true;
    const own = new AbortController();
    controller = own;
    // The assistant message the next `text` / `hits` event appends to; `done` closes it.
    let current: AssistantMessage | null = null;
    const fail = (kind: AssistantFailure) => {
      // A failure before the first word still leaves a message to hang the error line on.
      (current ?? push('assistant', '')).error = kind;
    };
    // Re-armed by every event. Firing drops the connection the way a stop does, but says why — and not through
    // abort(), which would mark the answer as stopped by the person.
    rearm = (ms = SILENCE_MS) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        fail('timeout');
        own.abort();
      }, ms);
    };
    try {
      rearm();
      // Created inline rather than through newSession(), which clears the log — the question just pushed is in it.
      if (!sessionId.value) sessionId.value = (await repository.createAssistantSession()).id;
      for await (const event of open(sessionId.value, own.signal)) {
        if (own.signal.aborted) break;
        // An event while a card is open (a keepalive, say) must not shorten the watch back to a minute: the turn is
        // still standing at the card, and the person has five of them to answer in.
        rearm?.(awaiting.value ? APPROVAL_SILENCE_MS : SILENCE_MS);
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
        else if (event.type === 'report') current.reports = [...(current.reports ?? []), event.report];
        else if (event.type === 'card') attachCard(current, event.card);
        // The model call failed part-way. What arrived stays: it is what the reader already read.
        else current.error = event.code ?? 'failed';
      }
    } catch (error) {
      // A fetch rejects with AbortError after abort(); that is the expected way out, not a failure.
      if (!own.signal.aborted) {
        // 503 is the server saying there is no assistant any more — switched off, or its provider gone — which is
        // not something trying again changes. 429 is two different situations that the body's `code` tells apart.
        const status = error instanceof HttpError ? error.status : 0;
        fail(status === 503 ? 'unavailable' : status === 429 ? refusalOf(error) : 'failed');
        console.error('assistant stream failed', error);
      }
    } finally {
      clearTimeout(watchdog);
      if (controller === own) {
        controller = null;
        rearm = null;
        streaming.value = false;
        activity.value = null;
        awaiting.value = null;
      }
    }
  }

  /**
   * Which of the two refusals a 429 is, in the words the person needs: their own other tab is mid-answer
   * ("answering"), or this account has asked too often this minute ("rateLimited"). The server names it in the
   * body's `code`; a refusal it could not classify carries none, and gets the sentence that covers both.
   */
  function refusalOf(error: unknown): AssistantFailure {
    const body = error instanceof HttpError ? error.body : null;
    const code = typeof body === 'object' && body !== null && 'code' in body ? (body as { code: unknown }).code : '';
    if (code === 'busy') return 'answering';
    if (code === 'rate_limited') return 'rateLimited';
    return 'busy';
  }

  /**
   * A card goes on the message that raised it — except an approval coming back decided, which is the card that
   * asked, again, and closes it. While an approval is open the turn is standing still on the server, waiting for the
   * person; a minute of that is not a hung connection, so the watchdog moves to its long setting until they answer.
   */
  function attachCard(message: AssistantMessage, card: AssistantCard) {
    if (card.kind === 'approval') {
      const sameFile = (message.cards ?? []).filter(
        (c): c is ApprovalCard => c.kind === 'approval' && c.path === card.path,
      );
      if (card.decision && sameFile.length) {
        // The LAST card still waiting, not the first one for this file: a file refused and then asked about again
        // in the same turn leaves a decided card behind, and closing that one would leave the live buttons on the
        // question actually being asked. Nothing but the path identifies a card on the wire.
        const waiting = sameFile.filter((c) => !c.decision).at(-1);
        settleRead(waiting ?? sameFile[sameFile.length - 1], card.decision);
        return;
      }
      if (!card.decision) {
        awaiting.value = card.path;
        rearm?.(APPROVAL_SILENCE_MS);
      }
    }
    message.cards = [...(message.cards ?? []), card];
  }

  /** Closes an approval card: how it ended, what that means for later reads, and the turn moving again. */
  function settleRead(card: ApprovalCard, decision: NonNullable<ApprovalCard['decision']>) {
    card.decision = decision;
    if (decision === 'allowed' && !granted.value.includes(card.path)) granted.value = [...granted.value, card.path];
    if (awaiting.value === card.path) {
      awaiting.value = null;
      rearm?.();
    }
  }

  /** Stops the in-flight turn (panel closed); the partial answer stays in the list, marked as stopped. */
  function abort() {
    if (!controller) return;
    controller.abort();
    controller = null;
    clearTimeout(watchdog);
    rearm = null;
    streaming.value = false;
    activity.value = null;
    awaiting.value = null;
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
    sessionMax.value = repository.assistantSessionMax();
  }

  /** Starts a conversation and shows it empty. Reaching the cap evicts, so the list is reloaded from the answer. */
  async function newSession() {
    abort();
    // A conversation still being opened is no longer wanted: its messages must not land in the empty chat.
    opening = null;
    const session = await repository.createAssistantSession();
    messages.value = [];
    granted.value = [];
    mode.value = settings.settings.assistantMode;
    sessionId.value = session.id;
    await loadSessions();
    return session;
  }

  /** Opens a stored conversation: its messages come from the server, which is the only place they live. */
  async function openSession(id: string) {
    abort();
    opening = id;
    const conversation = await repository.assistantMessages(id);
    // Nothing is applied until the messages are here. `sessionId` used to be set first, so a conversation that
    // could not be read — deleted in another tab, evicted by the cap — left the id pointing at nothing with the
    // PREVIOUS conversation's messages under it, and the next question went into that void. Two quick clicks
    // answering out of order wrote the wrong conversation's messages the same way.
    if (opening !== id) return;
    opening = null;
    sessionId.value = id;
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
      // Forgotten here rather than through the watcher: `sessionId` never took this id — the open is applied only
      // once it succeeds — so there is no change for the watcher to mirror into storage.
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // storage unavailable; nothing was remembered in the first place
      }
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
    // The running turn belongs to the conversation being removed, so it goes with it: left alone it went on writing
    // into a message list that is about to be thrown away, held "generating" (up to five minutes while an approval
    // card waits) with the box disabled, and had the server appending an answer to a conversation that is gone.
    if (sessionId.value === id) abort();
    if (opening === id) opening = null;
    await repository.deleteAssistantSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (sessionId.value === id) {
      sessionId.value = null;
      messages.value = [];
      granted.value = [];
    }
  }

  /**
   * Answers a request to read ONE file, for this conversation only. Nothing is said in the chat: the turn is standing
   * at the card, and the answer reaches the model as the tool's result — contents, or a refusal — the way an
   * interrupt is served, not the way a message is sent.
   */
  async function decideRead(card: ApprovalCard, allow: boolean) {
    const key = cardKey(card);
    if (!sessionId.value || card.decision || deciding.value.includes(key)) return;
    deciding.value = [...deciding.value, key];
    decisionError.value = null;
    try {
      await repository.decideAssistantRead(sessionId.value, card.path, allow);
    } catch (error) {
      decisionError.value = { card: key, message: errorMessage(error) };
      await resyncCard(card);
      return;
    } finally {
      deciding.value = deciding.value.filter((each) => each !== key);
    }
    settleRead(card, allow ? 'allowed' : 'denied');
  }

  /** Identifies a card across the store and the panel; a plan id and a file path never share a namespace. */
  function cardKey(card: ApprovalCard | PlanCard) {
    return card.kind === 'plan' ? `plan:${card.id}` : `read:${card.path}`;
  }

  /** Whether an answer to this card is already on its way, so the buttons can stop offering to send another. */
  function isDeciding(card: ApprovalCard | PlanCard) {
    return deciding.value.includes(cardKey(card));
  }

  /** What went wrong answering this card, or null. Per card, because only the card that failed should say so. */
  function decisionErrorOf(card: ApprovalCard | PlanCard) {
    return decisionError.value?.card === cardKey(card) ? decisionError.value.message : null;
  }

  /**
   * The server refused the decision, so the card is no longer describing anything real: a 409 means it was already
   * answered (the other half of a double click, or another tab), a 404 that the conversation is gone. What the
   * server holds is read back and written onto the card, rather than leaving live buttons on a settled card.
   */
  async function resyncCard(card: ApprovalCard | PlanCard) {
    if (!sessionId.value) return;
    let stored: AssistantCard[];
    try {
      const conversation = await repository.assistantMessages(sessionId.value);
      stored = conversation.messages.flatMap((message) => message.cards ?? []);
    } catch {
      // The conversation itself cannot be read any more, which is an answer too: the card is closed.
      if (card.kind === 'plan') card.status = 'cancelled';
      else settleRead(card, 'expired');
      return;
    }
    if (card.kind === 'plan') {
      const found = stored.find((each): each is PlanCard => each.kind === 'plan' && each.id === card.id);
      if (!found) return;
      card.status = found.status;
      if (found.results) card.results = found.results;
      return;
    }
    const found = stored.find((each): each is ApprovalCard => each.kind === 'approval' && each.path === card.path);
    if (found?.decision) settleRead(card, found.decision);
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
   *
   * ⚠ Nothing is SAID in the chat on the app's behalf. The outcome used to be reported by sending a message worded
   * as the person ("I did not approve that plan") — words nobody typed, answered by a model turn that had nothing
   * to add. The server writes its own line instead, as the executor, and that line is what goes into the log here.
   */
  async function decidePlan(card: PlanCard, approve: boolean): Promise<PlanOutcome | null> {
    const key = cardKey(card);
    if (!sessionId.value || card.status !== 'pending' || deciding.value.includes(key)) return null;
    deciding.value = [...deciding.value, key];
    decisionError.value = null;
    let outcome: PlanOutcome;
    try {
      outcome = await repository.decideAssistantPlan(sessionId.value, card.id, approve);
      card.status = outcome.status;
      if (outcome.results.length) card.results = outcome.results;
      if (outcome.note) messages.value.push(outcome.note);
    } catch (error) {
      decisionError.value = { card: key, message: errorMessage(error) };
      await resyncCard(card);
      return null;
    } finally {
      deciding.value = deciding.value.filter((each) => each !== key);
    }
    // Work the plan did not do is still work: the assistant is let back in to deal with it. A plan that ran in full
    // and a plan that was refused both end here — the conversation waits for the person to ask something else.
    if (outcome.status === 'done' && outcome.skipped + outcome.failed > 0) void resume();
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
    sessionMax,
    sessionId,
    mode,
    streaming,
    granted,
    activity,
    awaiting,
    send,
    decideRead,
    isGranted,
    decidePlan,
    isDeciding,
    decisionErrorOf,
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
