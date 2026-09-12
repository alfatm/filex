<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { Ban, CheckCheck, Copy, File, Loader2, Maximize2, MessagesSquare, Play, Search, Send, Sparkles, SquarePen, Tag, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import type { ApprovalCard, AssistantMessage, AssistantMode, PlanCard } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { useSearchStore } from '@/features/search/searchStore';
import { useSettingsStore } from '@/features/settings/settingsStore';
import { useToastStore } from '@/stores/toast';
import { Avatar, Button, IconButton, SidePanel } from '@/ui';
import Modal from '@/ui/Modal.vue';
import { ASSISTANT_MODES, useAssistantStore } from './assistantStore';
import { plainAnswer } from './answer';
import { ASSISTANT_TOOLS } from './tools';
import { pageContext } from './context';
import { planText } from './plan';
import AnswerText from './AnswerText.vue';
import PlanDetails from './PlanDetails.vue';
import ReportCard from './ReportCard.vue';
import ResultCard from './ResultCard.vue';
import SessionList from './SessionList.vue';

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatTime } = useFormat();
const route = useRoute();
const files = useFilesStore();
const view = useViewStore();
const search = useSearchStore();
const assistant = useAssistantStore();
const settings = useSettingsStore();
const toast = useToastStore();

/**
 * This browser's own switch (User settings → AI assistant). It is not the same question as the server's: an
 * installation with no provider reports no assistant at all and the panel is never offered, while THIS decides
 * whether the person wants it while it is on offer. Off means the panel closes, and stays closed.
 */
watch(() => settings.settings.assistantEnabled, (on) => {
  if (!on) emit('close');
}, { immediate: true });

const MODE_ICONS = { filename: File, content: Search, tags: Tag } satisfies Record<AssistantMode, Component>;
/** The magnet holds while the reader is this close to the end, and lets go as soon as they scroll away from it. */
const NEAR_BOTTOM_PX = 40;

/** The panel shows either the conversation or the list of them; the header switches between the two. */
const showSessions = ref(false);
const draft = ref('');
const online = ref(navigator.onLine);
const log = ref<HTMLElement>();
const logBody = ref<HTMLElement>();
const textarea = ref<HTMLTextAreaElement>();

const canSend = computed(() => online.value && !assistant.streaming);

/** An assistant message right after another assistant message is a follow-up: plain line, no bubble. */
const rows = computed(() =>
  assistant.messages.map((message, i, all) => ({
    message,
    followUp: message.role === 'assistant' && all[i - 1]?.role === 'assistant',
    streaming: assistant.streaming && i === all.length - 1,
  })),
);

/** Screen readers hear the finished answer once, instead of every streamed word. */
const announcement = computed(() => {
  const last = assistant.messages.at(-1);
  return !assistant.streaming && last?.role === 'assistant' ? plainAnswer(last.text) : '';
});

async function openSession(id: string) {
  await assistant.openSession(id);
  showSessions.value = false;
  // The log is unmounted while the list is up, so nothing was watching the height when these messages landed: it
  // mounts at the top otherwise, and a conversation is read from its end.
  await nextTick();
  scrollToEnd();
}

/**
 * What the assistant is doing right now, in words, while it does it — and "Thinking…" from the question until the
 * first word or tool, which used to be a blank: the model's first token can be many seconds away, and a panel that
 * shows nothing for them reads as a request that never left.
 */
const activityLabel = computed(() => {
  const running = assistant.activity;
  if (running) {
    // A tool from a newer server shows its bare name rather than a missing-translation key.
    const name = (ASSISTANT_TOOLS as readonly string[]).includes(running.tool) ? t(`assistant.tools.${running.tool}`) : running.tool;
    return running.target ? `${name} ${running.target}` : name;
  }
  // Standing at a permission card is not thinking: the card, with its buttons, is what is happening.
  if (assistant.awaiting) return '';
  const last = assistant.messages.at(-1);
  return assistant.streaming && !(last?.role === 'assistant' && last.text) ? t('assistant.thinking') : '';
});

/**
 * How a permission card ended: what the card itself says, or — for a conversation from before cards carried it — the
 * grant list. Null while the buttons are still on it.
 */
function decisionOf(card: ApprovalCard) {
  return card.decision ?? (assistant.isGranted(card) ? 'allowed' : null);
}

/**
 * The person's answer to a plan. Approving runs what the SERVER stored — this sends no work of its own — and the
 * executor writes what it did into the log itself; nothing is said here on anybody's behalf.
 */
async function decidePlan(card: PlanCard, approve: boolean) {
  const outcome = await assistant.decidePlan(card, approve);
  if (!outcome) return;
  if (expanded.value === card) expanded.value = null;
  // The server moved, tagged or removed something behind the listing on screen; it is re-read, not left stale.
  if (outcome.done > 0) void files.reload();
}

/**
 * The executor's line, in the reader's language. It is drawn from the decision's codes and counts, not from the
 * English sentence stored beside them — that one is for the model, and is only fallen back on if a newer server
 * sends a note this panel has no words for.
 */
function systemLine(message: AssistantMessage) {
  const decision = message.planDecision;
  if (!decision) return message.text;
  if (decision.status === 'cancelled') return t('assistant.plan.refusedNote');
  return t('assistant.plan.executedNote', { done: decision.done, skipped: decision.skipped + decision.failed });
}

/** The plan as text, addresses and all: to paste into a ticket or a message before, or instead of, approving it. */
async function copyPlan(card: PlanCard) {
  await navigator.clipboard.writeText(planText(card, t));
  toast.push(t('assistant.plan.copied'));
}

/**
 * A plan opened in full. The card caps its list and scrolls it — a plan may carry fifty lines, a thousand for tags —
 * and the modal is the same list with the width and height to actually read it. Approving there is the same call.
 */
const expanded = ref<PlanCard | null>(null);

async function startNewChat() {
  await assistant.newSession();
  showSessions.value = false;
}

/** Every question travels with what is on screen — the open folder, the selection, the search — so "these files" means something. */
function send(text: string) {
  if (!canSend.value) return;
  void assistant.send(text, pageContext(route.name, files, search));
  draft.value = '';
  // Asking is an answer to "am I still reading back there?": the log goes to the end and follows the reply.
  stuck.value = true;
}

function setOnline() {
  online.value = navigator.onLine;
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.defaultPrevented) emit('close');
}

// Roving tabindex: Tab reaches the checked chip, arrows move (and check) within the group.
function onModeKeydown(event: KeyboardEvent, index: number) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const next = ASSISTANT_MODES[(index + step + ASSISTANT_MODES.length) % ASSISTANT_MODES.length];
  assistant.mode = next;
  (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[ASSISTANT_MODES.indexOf(next)]?.focus();
}

/**
 * The magnet: at the end of the log, the log follows whatever arrives; scrolled up to re-read, it stays exactly
 * where the reader left it, and takes hold again the moment they come back down.
 *
 * What is watched is the conversation's HEIGHT, not its messages. A streamed word, a search result, a plan card,
 * the activity line, a word wrapping onto a second row, the panel being dragged narrower — all of them make the log
 * taller, and only the element knows about all of them. The message list, watched instead, described a few of them.
 */
const stuck = ref(true);

function scrollToEnd() {
  const el = log.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  stuck.value = true;
}

function onLogScroll() {
  const el = log.value;
  if (el) stuck.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

const grew = new ResizeObserver(() => {
  if (stuck.value) scrollToEnd();
});
// Re-attached rather than attached once: the log is unmounted while the session list is up.
watch(logBody, (body, previous) => {
  if (previous) grew.unobserve(previous);
  if (body) grew.observe(body);
});

onMounted(() => {
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  window.addEventListener('keydown', onWindowKeydown);
  scrollToEnd();
  textarea.value?.focus();
  // The last conversation comes back with the panel; the auto-scroll watcher takes it to the end once it lands.
  void assistant.restore();
});
onBeforeUnmount(() => {
  window.removeEventListener('online', setOnline);
  window.removeEventListener('offline', setOnline);
  window.removeEventListener('keydown', onWindowKeydown);
  grew.disconnect();
  assistant.abort();
});
</script>

<template>
  <SidePanel
    :width="view.assistantWidth"
    mobile="full"
    :resize-label="t('assistant.resize')"
    :aria-label="t('assistant.title')"
    @resize="view.setAssistantWidth"
    @close="emit('close')"
  >
    <!-- Spec §6: the icon sits at x 1290, 28px in from the panel's content edge. -->
    <div class="flex shrink-0 items-center pl-7">
      <Sparkles :size="26" class="shrink-0 text-primary" />
      <div class="ml-3 min-w-0 flex-1">
        <h2 class="text-17 font-semibold leading-tight">{{ t('assistant.title') }}</h2>
        <p class="mt-0.5 flex items-center text-11 leading-none text-text-3">
          <span class="mr-1.5 inline-block h-2 w-2 rounded-full" :class="online ? 'bg-success' : 'bg-text-3'" />
          {{ t(online ? 'assistant.online' : 'assistant.offline') }}
        </p>
      </div>
      <IconButton :label="t('assistant.newChat')" :size="36" @click="startNewChat"><SquarePen :size="20" /></IconButton>
      <IconButton
        :label="showSessions ? t('assistant.backToChat') : t('assistant.sessions')"
        :size="36"
        :active="showSessions"
        @click="showSessions = !showSessions"
      >
        <MessagesSquare :size="20" />
      </IconButton>
      <IconButton :label="t('assistant.close')" :size="36" class="-mr-2" @click="emit('close')"><X :size="22" /></IconButton>
    </div>

    <SessionList v-if="showSessions" @open="openSession" />

    <template v-else>
      <div ref="log" role="log" aria-live="off" class="scroll-thin -mr-2 mt-4 min-h-0 flex-1 overflow-y-auto pr-2" @scroll="onLogScroll">
        <!-- The inner box is what the magnet measures: a scroll container reports its own fixed height, never the
             height of what is in it. -->
        <div ref="logBody" class="space-y-3">
          <!-- The intro is a placeholder for the empty log, not a heading: the first message takes its place. -->
          <p v-if="!assistant.messages.length" class="text-13 leading-normal text-text-3">{{ t('assistant.intro') }}</p>
          <template v-for="{ message, followUp, streaming } in rows" :key="message.id">
            <!-- The executor: neither the person nor the assistant, so it is drawn as neither — one quiet line saying
                 what the server did once the plan was decided. -->
            <div v-if="message.role === 'system'" class="flex items-start gap-3 rounded-xl border border-border-soft bg-bg-muted px-4 py-3">
              <component
                :is="message.planDecision?.status === 'cancelled' ? Ban : CheckCheck"
                :size="16"
                class="mt-0.5 shrink-0 text-text-3"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="text-12 leading-snug text-text-2">{{ systemLine(message) }}</p>
                <p class="mt-1 text-10 leading-none text-text-3">{{ formatTime(message.at) }}</p>
              </div>
            </div>
            <div v-else-if="message.role === 'user'" class="flex items-start justify-end">
              <div class="max-w-[300px] rounded-xl bg-primary-soft px-4 py-3">
                <p class="whitespace-pre-wrap text-13 leading-[1.45]">{{ message.text }}</p>
                <p class="mt-1 text-10 leading-none text-text-3">{{ formatTime(message.at) }}</p>
              </div>
              <Avatar :initial="files.user?.initial ?? ''" :src="files.user?.avatarUrl" class="ml-3" />
            </div>
            <div v-else-if="followUp" :aria-live="streaming ? 'off' : undefined">
              <AnswerText :text="message.text" />
              <p v-if="message.error" class="mt-1 text-11.5 text-danger">{{ t(`assistant.failure.${message.error}`) }}</p>
              <p v-else-if="message.aborted" class="mt-1 text-11 text-text-3">{{ t('assistant.stopped') }}</p>
              <p class="mt-1 text-10 leading-none text-text-3">{{ formatTime(message.at) }}</p>
            </div>
            <div v-else class="space-y-3">
              <div class="flex items-start">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border">
                  <Sparkles :size="16" class="text-primary" />
                </span>
                <div class="ml-3 min-w-0 rounded-xl bg-bg-muted px-4 py-3" :aria-live="streaming ? 'off' : undefined">
                  <AnswerText :text="message.text" />
                  <p v-if="message.error" class="mt-1 text-11.5 text-danger">{{ t(`assistant.failure.${message.error}`) }}</p>
                  <p v-else-if="message.aborted" class="mt-1 text-11 text-text-3">{{ t('assistant.stopped') }}</p>
                  <p class="mt-1 text-10 leading-none text-text-3">{{ formatTime(message.at) }}</p>
                </div>
              </div>
              <!-- All hits of one answer read as a single result list, not as a stack of separate cards. -->
              <div v-if="message.hits?.length" class="divide-y divide-border-soft overflow-hidden rounded-lg border border-border">
                <ResultCard v-for="hit in message.hits" :key="hit.node.id" :hit="hit" />
              </div>
              <ReportCard v-for="(report, at) in message.reports" :key="at" :report="report" />

              <!-- Spec §6: permission is asked for one file at a time, and the card says which file and why. -->
              <template v-for="(card, at) in message.cards" :key="at">
                <!-- A plan: everything it would do, listed, before anything is done. -->
                <div v-if="assistant.isPlan(card)" class="rounded-2xl border border-border-soft bg-bg-muted p-4">
                  <div class="flex items-start gap-3">
                    <Sparkles :size="22" class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                    <p class="min-w-0 flex-1 text-13 font-medium leading-snug">{{ card.summary || t('assistant.plan.title') }}</p>
                    <IconButton :label="t('assistant.plan.copy')" :size="28" class="-mt-1 shrink-0 text-text-2" @click="copyPlan(card)">
                      <Copy :size="16" />
                    </IconButton>
                    <IconButton :label="t('assistant.plan.expand')" :size="28" class="-mr-1 -mt-1 shrink-0 text-text-2" @click="expanded = card">
                      <Maximize2 :size="16" />
                    </IconButton>
                  </div>
                  <PlanDetails :card="card" list-class="max-h-[400px]" />
                  <div v-if="card.status === 'pending'" class="mt-3 flex flex-wrap gap-[10px]">
                    <button
                      type="button"
                      :disabled="!canSend || assistant.isDeciding(card)"
                      class="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-11.5 font-medium leading-none text-white hover:bg-primary-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                      @click="decidePlan(card, true)"
                    >
                      <Play :size="16" fill="currentColor" :stroke-width="0" aria-hidden="true" />
                      {{ t('assistant.plan.approve') }}
                    </button>
                    <button
                      type="button"
                      :disabled="!canSend || assistant.isDeciding(card)"
                      class="inline-flex h-10 items-center rounded-full border border-border bg-bg px-5 text-11.5 font-medium leading-none text-text hover:bg-hover-row disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                      @click="decidePlan(card, false)"
                    >
                      {{ t('assistant.plan.refuse') }}
                    </button>
                  </div>
                  <p v-else-if="card.status === 'cancelled'" class="mt-3 text-11 leading-none text-text-3">{{ t('assistant.plan.cancelled') }}</p>
                  <p v-if="assistant.decisionErrorOf(card)" class="mt-2 text-11 leading-snug text-danger" role="alert">{{ assistant.decisionErrorOf(card) }}</p>
                </div>

                <div v-else class="rounded-xl border border-border p-4">
                <p class="text-11.5 font-medium leading-snug">{{ t('assistant.card.title') }}</p>
                <p class="mt-1 break-all text-11.5 leading-snug text-text-3">{{ card.path }}</p>
                <p v-if="card.reason" class="mt-1 text-11 leading-snug text-text-3">{{ card.reason }}</p>
                <p
                  v-if="decisionOf(card)"
                  class="mt-3 text-11 leading-none"
                  :class="decisionOf(card) === 'allowed' ? 'text-success' : 'text-text-3'"
                >
                  {{ t(`assistant.card.${decisionOf(card)}`) }}
                </p>
                <!-- Answered while the turn streams — that is the point: the turn is waiting for exactly this. -->
                <div v-else class="mt-3 flex flex-wrap gap-[10px]">
                  <button
                    type="button"
                    :disabled="!online || assistant.isDeciding(card)"
                    class="inline-flex h-9 items-center rounded-full bg-primary px-4 text-11.5 leading-none text-white hover:bg-primary-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                    @click="assistant.decideRead(card, true)"
                  >
                    {{ t('assistant.card.allow') }}
                  </button>
                  <button
                    type="button"
                    :disabled="!online || assistant.isDeciding(card)"
                    class="inline-flex h-9 items-center rounded-full border border-border px-4 text-11.5 leading-none text-text hover:bg-hover-row disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                    @click="assistant.decideRead(card, false)"
                  >
                    {{ t('assistant.card.deny') }}
                  </button>
                </div>
                <p v-if="assistant.decisionErrorOf(card)" class="mt-2 text-11 leading-snug text-danger" role="alert">{{ assistant.decisionErrorOf(card) }}</p>
                </div>
              </template>
            </div>
          </template>
          <p v-if="activityLabel" class="flex items-center text-11 leading-snug text-text-3">
            <Loader2 :size="14" class="mr-2 shrink-0 animate-spin" />
            <span class="min-w-0 break-all">{{ activityLabel }}</span>
          </p>
        </div>
      </div>
      <p role="status" class="sr-only">{{ announcement }}</p>

      <div class="shrink-0 pt-4">
        <div role="radiogroup" :aria-label="t('assistant.modeLabel')" class="flex gap-[10px]">
          <button
            v-for="(mode, index) in ASSISTANT_MODES"
            :key="mode"
            type="button"
            role="radio"
            :aria-checked="assistant.mode === mode"
            :tabindex="assistant.mode === mode ? 0 : -1"
            :title="t(`assistant.modeHint.${mode}`)"
            class="inline-flex h-[38px] items-center gap-2 rounded-full px-4 text-13 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            :class="assistant.mode === mode ? 'bg-primary text-white' : 'border border-border text-text hover:bg-hover-row'"
            @click="assistant.mode = mode"
            @keydown="onModeKeydown($event, index)"
          >
            <component :is="MODE_ICONS[mode]" :size="16" />
            {{ t(`assistant.mode.${mode}`) }}
          </button>
        </div>

        <form class="mt-4 flex items-start gap-[10px]" @submit.prevent="send(draft)">
          <!-- Typing the next question while the answer streams is fine; only sending waits. -->
          <textarea
            ref="textarea"
            v-model="draft"
            rows="1"
            :disabled="!online"
            :placeholder="t('assistant.placeholder')"
            :aria-label="t('assistant.placeholder')"
            class="h-10 min-w-0 flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-13 leading-[1.45] text-text placeholder:text-text-3 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-bg-muted"
            @keydown.enter.exact.prevent="send(draft)"
          />
          <button
            type="submit"
            :disabled="!canSend"
            :aria-label="t('assistant.send')"
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-60 disabled:hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
          >
            <Send :size="18" />
          </button>
        </form>
      </div>
    </template>
  </SidePanel>

  <!-- The plan in full: the same list as the card, with room to read it, and the same decision buttons. -->
  <Modal
    v-if="expanded"
    :title="expanded.summary || t('assistant.plan.title')"
    :close-label="t('modal.close')"
    :width="720"
    @close="expanded = null"
  >
    <PlanDetails :card="expanded" />
    <p v-if="expanded.status === 'cancelled'" class="mt-3 text-11 leading-none text-text-3">{{ t('assistant.plan.cancelled') }}</p>
    <template v-if="expanded.status === 'pending'" #footer>
      <Button variant="outline" :disabled="!canSend || assistant.isDeciding(expanded)" @click="decidePlan(expanded, false)">{{ t('assistant.plan.refuse') }}</Button>
      <Button :disabled="!canSend || assistant.isDeciding(expanded)" class="disabled:opacity-60" @click="decidePlan(expanded, true)">{{ t('assistant.plan.approve') }}</Button>
    </template>
  </Modal>
</template>
