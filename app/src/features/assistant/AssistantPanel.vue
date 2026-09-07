<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { File, Search, Send, Sparkles, Tag, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import type { AssistantMode } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { Avatar, IconButton, SidePanel } from '@/ui';
import { ASSISTANT_MODES, useAssistantStore } from './assistantStore';
import ResultCard from './ResultCard.vue';

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatTime } = useFormat();
const files = useFilesStore();
const assistant = useAssistantStore();

const MODE_ICONS = { filename: File, content: Search, tags: Tag } satisfies Record<AssistantMode, Component>;
const SUGGESTIONS = ['contracts', 'tag'] as const;
/** Auto-scroll follows the stream only while the reader is this close to the end. */
const NEAR_BOTTOM_PX = 40;

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
      <IconButton :label="t('assistant.close')" :size="36" class="-mr-2" @click="emit('close')"><X :size="22" /></IconButton>
    </div>

    <p class="mt-4 shrink-0 text-15 leading-normal text-text-3">{{ t('assistant.intro') }}</p>

    <div ref="log" role="log" aria-live="off" class="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
      <template v-for="{ message, followUp, streaming } in rows" :key="message.id">
        <div v-if="message.role === 'user'" class="flex items-start justify-end">
          <div class="max-w-[300px] rounded-xl bg-primary-soft px-4 py-3">
            <p class="whitespace-pre-wrap text-15 leading-[1.45]">{{ message.text }}</p>
            <p class="mt-1 text-12 leading-none text-text-3">{{ formatTime(message.at) }}</p>
          </div>
          <Avatar :initial="files.user?.initial ?? ''" class="ml-3" />
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
        </div>
      </template>
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
      <p class="mt-2 text-13 leading-none text-text-3">{{ t('assistant.hint') }}</p>
    </div>
  </SidePanel>
</template>
