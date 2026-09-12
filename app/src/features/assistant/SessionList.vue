<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Pencil, Trash2, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import { IconButton, Input } from '@/ui';
import { useAssistantStore } from './assistantStore';

/**
 * The account's conversations. Searching happens here rather than on the server: the server caps the history and
 * hands over the whole of it, so the list is already loaded and a round trip would only make the filter slower.
 */
const emit = defineEmits<{ open: [id: string] }>();

const { t } = useI18n();
const { formatDateTime } = useFormat();
const assistant = useAssistantStore();

const query = ref('');
const editing = ref<string | null>(null);
const draft = ref('');
const editor = ref<InstanceType<typeof Input>>();

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return assistant.sessions;
  return assistant.sessions.filter((session) => titleOf(session.title).toLowerCase().includes(needle));
});

/** A conversation the title generator has not named yet still needs something to be called in the list. */
function titleOf(title: string): string {
  return title.trim() || t('assistant.untitled');
}

async function startRename(id: string, title: string) {
  editing.value = id;
  draft.value = title;
  await nextTick();
  editor.value?.focus();
}

async function commitRename(id: string) {
  const title = draft.value.trim();
  editing.value = null;
  if (title) await assistant.renameSession(id, title);
}

onMounted(() => void assistant.loadSessions());
</script>

<template>
  <div class="mt-4 flex min-h-0 flex-1 flex-col">
    <Input v-model="query" :height="40" :placeholder="t('assistant.searchSessions')" :label="t('assistant.searchSessions')" />
    <p class="mt-2 shrink-0 text-11 leading-normal text-text-3">
      {{ t('assistant.capacity', { count: assistant.sessions.length, max: assistant.sessionMax }) }}
    </p>

    <ul v-if="shown.length" class="scroll-thin -mr-2 mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-2" :aria-label="t('assistant.sessions')">
      <li v-for="session in shown" :key="session.id" class="group flex items-center gap-1 rounded-lg px-1 hover:bg-hover-row">
        <template v-if="editing === session.id">
          <Input
            ref="editor"
            v-model="draft"
            :height="36"
            class="min-w-0 flex-1"
            :label="t('assistant.renameTitle')"
            @enter="commitRename(session.id)"
            @keydown.esc="editing = null"
          />
          <IconButton :label="t('modal.save')" :size="32" @click="commitRename(session.id)"><Check :size="16" /></IconButton>
          <IconButton :label="t('modal.cancel')" :size="32" @click="editing = null"><X :size="16" /></IconButton>
        </template>
        <template v-else>
          <button
            type="button"
            class="min-w-0 flex-1 rounded-md py-2 pl-2 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
            :class="assistant.sessionId === session.id && 'font-medium text-primary'"
            @click="emit('open', session.id)"
          >
            <span class="block truncate-safe text-13 leading-none">{{ titleOf(session.title) }}</span>
            <span class="mt-1.5 block truncate-safe text-11 leading-none text-text-3">
              {{ t('assistant.sessionMeta', session.messageCount) }} · {{ formatDateTime(session.lastActiveAt) }}
            </span>
          </button>
          <!-- Shown on hover and on keyboard focus alike: a control only a mouse can reach is not a control. -->
          <span class="hover-reveal flex shrink-0">
            <IconButton
              :label="t('assistant.rename', { title: titleOf(session.title) })"
              :size="32"
              class="text-text-3"
              @click="startRename(session.id, session.title)"
            >
              <Pencil :size="16" />
            </IconButton>
            <IconButton
              :label="t('assistant.deleteSession', { title: titleOf(session.title) })"
              :size="32"
              class="text-text-3 hover:!text-danger"
              @click="assistant.removeSession(session.id)"
            >
              <Trash2 :size="16" />
            </IconButton>
          </span>
        </template>
      </li>
    </ul>
    <p v-else class="mt-6 text-13 leading-none text-text-3">
      {{ assistant.sessions.length ? t('assistant.noMatches') : t('assistant.noSessions') }}
    </p>
  </div>
</template>
