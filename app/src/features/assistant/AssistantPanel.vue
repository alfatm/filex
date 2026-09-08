<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { File, Loader2, MessagesSquare, Search, Send, Sparkles, SquarePen, Tag, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import type { ApprovalCard, AssistantMode, PlanCard, PlanItem, PlanResult } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { Avatar, IconButton, SidePanel } from '@/ui';
import { ASSISTANT_MODES, useAssistantStore } from './assistantStore';
import ResultCard from './ResultCard.vue';
import SessionList from './SessionList.vue';

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatDate, formatSize, formatTime } = useFormat();
const files = useFilesStore();
const assistant = useAssistantStore();

const MODE_ICONS = { filename: File, content: Search, tags: Tag } satisfies Record<AssistantMode, Component>;
const SUGGESTIONS = ['contracts', 'tag'] as const;
/** Auto-scroll follows the stream only while the reader is this close to the end. */
const NEAR_BOTTOM_PX = 40;

/** The panel shows either the conversation or the list of them; the header switches between the two. */
const showSessions = ref(false);
const draft = ref('');
const online = ref(navigator.onLine);
const log = ref<HTMLElement>();
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
  return !assistant.streaming && last?.role === 'assistant' ? last.text : '';
});

async function openSession(id: string) {
  await assistant.openSession(id);
  showSessions.value = false;
}

/** The tools the panel has words for; anything else shows its bare name rather than a missing-translation key. */
const KNOWN_TOOLS = ['list_storages', 'list_folder', 'search_files', 'read_file'] as const;

/** What the assistant is doing right now, in words, while it does it. */
const activityLabel = computed(() => {
  const running = assistant.activity;
  if (!running) return '';
  const name = (KNOWN_TOOLS as readonly string[]).includes(running.tool) ? t(`assistant.tools.${running.tool}`) : running.tool;
  return running.target ? `${name} ${running.target}` : name;
});

/**
 * Permission for ONE file. The grant is recorded server-side and then said out loud in the chat: everything the
 * assistant is told has to be visible in the conversation, a permission most of all.
 *
 * ⚠ The path is quoted in that sentence (`assistant.card.allowedPrompt`) rather than left bare. A model reading
 * "You may read main://a/notes.md." takes the sentence's full stop for part of the name, calls read_file with it,
 * and is refused — correctly, since the grant is an exact match, but for a reason nobody can see.
 */
async function allowRead(card: ApprovalCard) {
  await assistant.approveRead(card.path);
  send(t('assistant.card.allowedPrompt', { path: card.path }));
}

function refuseRead(card: ApprovalCard) {
  send(t('assistant.card.deniedPrompt', { path: card.path }));
}

/**
 * The person's answer to a plan. Approving runs what the SERVER stored — this sends no work of its own — and the
 * outcome is then said in the chat, so the assistant learns what actually happened rather than assuming.
 */
async function decidePlan(card: PlanCard, approve: boolean) {
  const outcome = await assistant.decidePlan(card, approve);
  if (!outcome) return;
  send(approve ? t('assistant.plan.approvedPrompt', { done: outcome.done, skipped: outcome.skipped + outcome.failed }) : t('assistant.plan.refusedPrompt'));
}

/** A skip or a failure, in the reader's language; an unknown code falls back to the server's English sentence. */
const RESULT_CODES = ['gone', 'changed', 'forbidden', 'missing', 'broken'] as const;

function resultReason(result: PlanResult) {
  if (result.code && (RESULT_CODES as readonly string[]).includes(result.code)) return t(`assistant.plan.reason.${result.code}`);
  return result.reason ?? '';
}

/** What one line of a plan does, in the reader's language. An action this build has no words for shows its code. */
const PLAN_ACTIONS = ['tag', 'restore_version', 'revoke_share', 'purge'] as const;

function itemAction(item: PlanItem) {
  if (!(PLAN_ACTIONS as readonly string[]).includes(item.action)) return item.action;
  return t(`assistant.plan.action.${item.action}`, item.args ?? {});
}

/**
 * The second line: the item as it stands. Which numbers matter depends on the plan — a version has a size and when
 * it was taken, a trashed file has a size and when it was deleted, a link has a date and a download count.
 */
function itemDetail(card: PlanCard, item: PlanItem) {
  const size = item.size ? formatSize(item.size) : '';
  const at = item.at ? formatDate(item.at) : '';
  if (card.planKind === 'empty_trash' && at) return t('assistant.plan.detail.deleted', { size, at });
  if (card.planKind === 'restore_version' && at) return t('assistant.plan.detail.taken', { size, at });
  if (card.planKind === 'revoke_share' && at) return t('assistant.plan.detail.link', { at, downloads: item.args?.downloads ?? '0' });
  return size;
}

async function startNewChat() {
  await assistant.newSession();
  showSessions.value = false;
}

function send(text: string) {
  if (!canSend.value) return;
  void assistant.send(text);
  draft.value = '';
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

function scrollToEnd() {
  log.value?.scrollTo({ top: log.value.scrollHeight });
}

// Keep the newest words in view while the answer streams, unless the reader scrolled up to re-read.
watch(
  () => assistant.messages.map((m) => m.text.length + (m.hits?.length ?? 0)).join(),
  async () => {
    const el = log.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    await nextTick();
    if (nearBottom) scrollToEnd();
  },
);

onMounted(() => {
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOnline);
  window.addEventListener('keydown', onWindowKeydown);
  scrollToEnd();
  textarea.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('online', setOnline);
  window.removeEventListener('offline', setOnline);
  window.removeEventListener('keydown', onWindowKeydown);
  assistant.abort();
});
</script>

<template>
  <SidePanel :width="432" :aria-label="t('assistant.title')">
    <!-- Spec §6: the icon sits at x 1290, 28px in from the panel's content edge. -->
    <div class="flex shrink-0 items-center pl-7">
      <Sparkles :size="26" class="shrink-0 text-primary" />
      <div class="ml-3 min-w-0 flex-1">
        <h2 class="text-20 font-semibold leading-tight">{{ t('assistant.title') }}</h2>
        <p class="mt-0.5 flex items-center text-13 leading-none text-text-3">
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
      <p class="mt-4 shrink-0 text-15 leading-normal text-text-3">{{ t('assistant.intro') }}</p>

      <div ref="log" role="log" aria-live="off" class="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
        <template v-for="{ message, followUp, streaming } in rows" :key="message.id">
          <div v-if="message.role === 'user'" class="flex items-start justify-end">
            <div class="max-w-[300px] rounded-xl bg-primary-soft px-4 py-3">
              <p class="whitespace-pre-wrap text-15 leading-[1.45]">{{ message.text }}</p>
              <p class="mt-1 text-12 leading-none text-text-3">{{ formatTime(message.at) }}</p>
            </div>
            <Avatar :initial="files.user?.initial ?? ''" :src="files.user?.avatarUrl" class="ml-3" />
          </div>
          <div v-else-if="followUp" :aria-live="streaming ? 'off' : undefined">
            <p class="text-15 leading-[1.45]">{{ message.text }}</p>
            <p v-if="message.error" class="mt-1 text-14 text-danger">{{ t('assistant.error') }}</p>
            <p v-else-if="message.aborted" class="mt-1 text-13 text-text-3">{{ t('assistant.stopped') }}</p>
            <p class="mt-1 text-12 leading-none text-text-3">{{ formatTime(message.at) }}</p>
          </div>
          <div v-else class="space-y-3">
            <div class="flex items-start">
              <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border">
                <Sparkles :size="16" class="text-primary" />
              </span>
              <div class="ml-3 min-w-0 rounded-xl bg-bg-muted px-4 py-3" :aria-live="streaming ? 'off' : undefined">
                <p class="whitespace-pre-wrap text-15 leading-[1.45]">{{ message.text }}</p>
                <p v-if="message.error" class="mt-1 text-14 text-danger">{{ t('assistant.error') }}</p>
                <p v-else-if="message.aborted" class="mt-1 text-13 text-text-3">{{ t('assistant.stopped') }}</p>
                <p class="mt-1 text-12 leading-none text-text-3">{{ formatTime(message.at) }}</p>
              </div>
            </div>
            <ResultCard v-for="hit in message.hits" :key="hit.node.id" :hit="hit" />

            <!-- Spec §6: permission is asked for one file at a time, and the card says which file and why. -->
            <template v-for="(card, at) in message.cards" :key="at">
              <!-- A plan: everything it would do, listed, before anything is done. -->
              <div v-if="assistant.isPlan(card)" class="rounded-xl border border-border p-4">
                <p class="text-14 font-medium leading-snug">{{ card.summary || t('assistant.plan.title') }}</p>
                <ul class="mt-2 space-y-1.5">
                  <li v-for="item in card.items" :key="item.path" class="text-13 leading-snug">
                    <span class="break-all text-text">{{ item.path }}</span>
                    <span class="text-text-3"> — {{ itemAction(item) }}</span>
                    <span v-if="itemDetail(card, item)" class="block text-12 text-text-3">{{ itemDetail(card, item) }}</span>
                  </li>
                </ul>
                <div v-if="card.status === 'pending'" class="mt-3 flex flex-wrap gap-[10px]">
                  <button
                    type="button"
                    :disabled="!canSend"
                    class="inline-flex h-9 items-center rounded-full bg-primary px-4 text-14 leading-none text-white hover:bg-primary-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                    @click="decidePlan(card, true)"
                  >
                    {{ t('assistant.plan.approve') }}
                  </button>
                  <button
                    type="button"
                    :disabled="!canSend"
                    class="inline-flex h-9 items-center rounded-full border border-border px-4 text-14 leading-none text-text hover:bg-hover-row disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                    @click="decidePlan(card, false)"
                  >
                    {{ t('assistant.plan.refuse') }}
                  </button>
                </div>
                <p v-else-if="card.status === 'cancelled'" class="mt-3 text-13 leading-none text-text-3">{{ t('assistant.plan.cancelled') }}</p>
                <template v-else>
                  <p class="mt-3 text-13 leading-none text-success">{{ t('assistant.plan.ran') }}</p>
                  <ul v-if="card.results?.length" class="mt-2 space-y-1">
                    <li v-for="result in card.results" :key="result.path" class="text-12 leading-snug text-text-3">
                      <span class="break-all">{{ result.path }}</span> — {{ result.state === 'done' ? t('assistant.plan.itemDone') : resultReason(result) }}
                    </li>
                  </ul>
                </template>
              </div>

              <div v-else class="rounded-xl border border-border p-4">
              <p class="text-14 font-medium leading-snug">{{ t('assistant.card.title') }}</p>
              <p class="mt-1 break-all text-14 leading-snug text-text-3">{{ card.path }}</p>
              <p v-if="card.reason" class="mt-1 text-13 leading-snug text-text-3">{{ card.reason }}</p>
              <p v-if="assistant.isGranted(card)" class="mt-3 text-13 leading-none text-success">{{ t('assistant.card.approved') }}</p>
              <div v-else class="mt-3 flex flex-wrap gap-[10px]">
                <button
                  type="button"
                  :disabled="!canSend"
                  class="inline-flex h-9 items-center rounded-full bg-primary px-4 text-14 leading-none text-white hover:bg-primary-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                  @click="allowRead(card)"
                >
                  {{ t('assistant.card.allow') }}
                </button>
                <button
                  type="button"
                  :disabled="!canSend"
                  class="inline-flex h-9 items-center rounded-full border border-border px-4 text-14 leading-none text-text hover:bg-hover-row disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                  @click="refuseRead(card)"
                >
                  {{ t('assistant.card.deny') }}
                </button>
              </div>
              </div>
            </template>
          </div>
        </template>
        <p v-if="activityLabel" class="flex items-center text-13 leading-snug text-text-3">
          <Loader2 :size="14" class="mr-2 shrink-0 animate-spin" />
          <span class="min-w-0 break-all">{{ activityLabel }}</span>
        </p>
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
            class="inline-flex h-[38px] items-center gap-2 rounded-full px-4 text-15 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            :class="assistant.mode === mode ? 'bg-primary text-white' : 'border border-border text-text hover:bg-hover-row'"
            @click="assistant.mode = mode"
            @keydown="onModeKeydown($event, index)"
          >
            <component :is="MODE_ICONS[mode]" :size="16" />
            {{ t(`assistant.mode.${mode}`) }}
          </button>
        </div>

        <div class="mt-3 flex flex-wrap gap-[10px]">
          <button
            v-for="id in SUGGESTIONS"
            :key="id"
            type="button"
            :disabled="!canSend"
            class="inline-flex h-9 items-center rounded-full border border-border px-4 text-14 leading-none text-text hover:bg-hover-row disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            @click="send(t(`assistant.suggestions.${id}`))"
          >
            {{ t(`assistant.suggestions.${id}`) }}
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
            class="h-14 min-w-0 flex-1 resize-none rounded-lg border border-border bg-bg px-4 py-4 text-15 leading-[1.45] text-text placeholder:text-text-3 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-bg-muted"
            @keydown.enter.exact.prevent="send(draft)"
          />
          <button
            type="submit"
            :disabled="!canSend"
            :aria-label="t('assistant.send')"
            class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-60 disabled:hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
          >
            <Send :size="22" />
          </button>
        </form>
      </div>
    </template>
  </SidePanel>
</template>
