<script setup lang="ts">
/**
 * The AI assistant's operator page: which model this installation talks to,
 * and how much conversation history each account is holding.
 *
 * ⚠ There is no "read this conversation" control here, and there is no
 * endpoint behind one either — an administrator may see that an account holds
 * forty conversations and clear one, and may never read a line of any. Same
 * for the API key: it is written and never read back. Both are properties of
 * the backend, not of this form; docs/ASSISTANT.md explains why.
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Activity, Save, Sparkles, Trash2 } from 'lucide-vue-next';

import { extractError } from '@/api/client';
import {
  AssistantApi,
  KEY_UNCHANGED,
  type AssistantProvider,
  type AssistantSessionRow,
  type AssistantTestResult,
} from '@/api/assistant';
import { formatRelative } from '@/lib/format';
import { useToastStore } from '@/stores/toast';

import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Spinner from '@/components/ui/Spinner.vue';
import Table, { type Column } from '@/components/ui/Table.vue';
import Toggle from '@/components/ui/Toggle.vue';

const { t, locale } = useI18n();
const toast = useToastStore();

const provider = ref<AssistantProvider | null>(null);
const sessions = ref<AssistantSessionRow[]>([]);
const loading = ref(true);
const loadingSessions = ref(true);
const saving = ref(false);
const testing = ref(false);
const testResult = ref<AssistantTestResult | null>(null);
const deletingId = ref<string | null>(null);
/** A tenant admin: the model provider is the platform operator's, one for the whole instance. */
const forbidden = ref(false);

/** The form. `apiKey` starts empty and is only sent when something is typed into it. */
const form = reactive({
  enabled: false,
  provider: 'openai',
  base_url: '',
  model: '',
  turns_per_minute: 20,
  apiKey: '',
});

function fill(p: AssistantProvider) {
  provider.value = p;
  form.enabled = p.enabled;
  form.provider = p.provider;
  form.base_url = p.base_url;
  form.model = p.model;
  form.turns_per_minute = p.turns_per_minute;
  form.apiKey = '';
}

/** Three states an operator has to be able to tell apart at a glance. */
const state = computed<{ tone: 'emerald' | 'amber' | 'zinc'; label: string }>(() => {
  const p = provider.value;
  if (!p) return { tone: 'zinc', label: t('assistant.state.unknown') };
  if (p.ready) return { tone: 'emerald', label: t('assistant.state.ready') };
  if (p.enabled) return { tone: 'amber', label: t('assistant.state.incomplete') };
  return { tone: 'zinc', label: t('assistant.state.off') };
});

const providerOptions = computed(() =>
  (provider.value?.providers ?? ['openai', 'anthropic']).map((id) => ({ value: id, label: id })),
);

async function load() {
  loading.value = true;
  try {
    fill(await AssistantApi.getProvider());
  } catch (e: unknown) {
    // Not a bug: in a multi-tenant install this surface belongs to the platform
    // operator, and a tenant admin is told so rather than shown a dead form.
    const err = e as { response?: { status?: number } };
    if (err?.response?.status === 403) forbidden.value = true;
    else toast.error(extractError(e, t('errors.generic')));
  } finally {
    loading.value = false;
  }
}

async function loadSessions() {
  loadingSessions.value = true;
  try {
    sessions.value = await AssistantApi.listSessions();
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    loadingSessions.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    fill(
      await AssistantApi.updateProvider({
        enabled: form.enabled,
        provider: form.provider,
        base_url: form.base_url,
        model: form.model,
        turns_per_minute: form.turns_per_minute,
        // Nothing typed means "leave the stored key alone"; the field is never filled in from the server.
        api_key: form.apiKey === '' ? KEY_UNCHANGED : form.apiKey,
      }),
    );
    testResult.value = null;
    toast.success(t('assistant.savedOk'));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    saving.value = false;
  }
}

/** Clears the stored key. Separate from Save so it cannot happen by accident. */
async function removeKey() {
  if (!window.confirm(t('assistant.removeKeyConfirm'))) return;
  saving.value = true;
  try {
    fill(await AssistantApi.updateProvider({ api_key: '' }));
    testResult.value = null;
    toast.success(t('assistant.keyRemoved'));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    saving.value = false;
  }
}

/**
 * One real call to the provider. It is the difference between "the form is
 * saved" and "the assistant works" — a wrong model name or a revoked key is
 * only visible at the moment somebody calls.
 */
async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await AssistantApi.test();
  } catch (e: unknown) {
    testResult.value = { ok: false, error: extractError(e, t('errors.generic')) };
  } finally {
    testing.value = false;
  }
}

async function removeSession(row: AssistantSessionRow) {
  if (!window.confirm(t('assistant.sessions.deleteConfirm', { email: row.user_email }))) return;
  deletingId.value = row.id;
  try {
    await AssistantApi.deleteSession(row.id);
    sessions.value = sessions.value.filter((s) => s.id !== row.id);
    toast.success(t('assistant.sessions.deleted'));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    deletingId.value = null;
  }
}

const columns = computed<Column<AssistantSessionRow>[]>(() => [
  { key: 'user_email', label: t('assistant.sessions.fields.owner') },
  { key: 'title', label: t('assistant.sessions.fields.name'), cell: 'slot' },
  { key: 'message_count', label: t('assistant.sessions.fields.messages'), align: 'right' },
  { key: 'last_active_at', label: t('assistant.sessions.fields.lastActive'), cell: 'slot' },
  { key: 'actions', label: '', align: 'right', cell: 'slot' },
]);

onMounted(() => {
  void load();
  void loadSessions();
});
</script>

<template>
  <div class="space-y-4 max-w-3xl">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2">
        <Sparkles class="h-5 w-5 text-brand-600 dark:text-brand-400" />
        {{ t('assistant.title') }}
      </h1>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('assistant.subtitle') }}
      </p>
    </div>

    <div
      v-if="loading"
      class="card card-body text-center text-zinc-500"
    >
      <Spinner />
    </div>

    <div
      v-else
      class="card card-body space-y-3"
    >
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-sm font-semibold flex items-center gap-2">
          {{ t('assistant.provider.title') }}
          <Badge
            :tone="state.tone"
            dot
          >
            {{ state.label }}
          </Badge>
        </h2>
        <span
          v-if="provider?.endpoint"
          class="text-xs font-mono text-zinc-500 truncate max-w-xs"
          :title="provider.endpoint"
        >
          {{ provider.endpoint }}
        </span>
      </div>
      <p
        v-if="provider?.problem"
        class="text-xs text-amber-600 dark:text-amber-400"
      >
        {{ provider.problem }}
      </p>

      <Toggle
        v-model="form.enabled"
        :label="t('assistant.fields.enabled')"
        :description="t('assistant.fields.enabledHint')"
      />
      <Select
        v-model="form.provider"
        :label="t('assistant.fields.provider')"
        :options="providerOptions"
        :hint="t('assistant.fields.providerHint')"
      />
      <Input
        v-model="form.base_url"
        :label="t('assistant.fields.baseUrl')"
        monospace
        placeholder="https://api.openai.com/v1"
        :hint="t('assistant.fields.baseUrlHint')"
      />
      <Input
        v-model="form.model"
        :label="t('assistant.fields.model')"
        monospace
        placeholder="gpt-4o-mini"
        :hint="t('assistant.fields.modelHint')"
      />
      <Input
        v-model.number="form.turns_per_minute"
        type="number"
        min="1"
        max="600"
        :label="t('assistant.fields.turnsPerMinute')"
        :hint="t('assistant.fields.turnsPerMinuteHint')"
      />
      <div class="space-y-1">
        <Input
          v-model="form.apiKey"
          type="password"
          autocomplete="off"
          monospace
          :label="t('assistant.fields.apiKey')"
          :placeholder="provider?.has_key ? '••••••••' : ''"
          :hint="provider?.has_key ? t('assistant.fields.apiKeyStored') : t('assistant.fields.apiKeyHint')"
        />
        <button
          v-if="provider?.has_key"
          type="button"
          class="text-xs text-rose-600 hover:underline dark:text-rose-400"
          @click="removeKey"
        >
          {{ t('assistant.removeKey') }}
        </button>
      </div>

      <div class="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :loading="testing"
          @click="test"
        >
          <Activity class="h-4 w-4" />
          {{ t('common.testNow') }}
        </Button>
        <Button
          size="sm"
          :loading="saving"
          @click="save"
        >
          <Save class="h-4 w-4" />
          {{ t('common.save') }}
        </Button>
      </div>

      <p
        v-if="testResult"
        class="text-xs font-mono"
        :class="testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'"
      >
        {{ testResult.ok ? t('assistant.testOk', { model: testResult.model, reply: testResult.reply }) : testResult.error }}
      </p>
    </div>

    <div class="card card-body space-y-3">
      <div>
        <h2 class="text-sm font-semibold">
          {{ t('assistant.sessions.title') }}
        </h2>
        <!-- Not a disclaimer: there is no endpoint that returns a conversation, so this page could not show one. -->
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          {{ t('assistant.sessions.subtitle') }}
        </p>
      </div>

      <Table
        :columns="columns"
        :rows="sessions"
        :loading="loadingSessions"
        :empty="t('assistant.sessions.none')"
        row-key="id"
      >
        <template #cell-title="{ row }">
          <span
            v-if="(row as AssistantSessionRow).title"
            class="text-xs"
          >{{ (row as AssistantSessionRow).title }}</span>
          <span
            v-else
            class="text-xs text-zinc-400"
          >{{ t('assistant.sessions.unnamed') }}</span>
        </template>
        <template #cell-last_active_at="{ row }">
          <span class="text-xs whitespace-nowrap">{{ formatRelative((row as AssistantSessionRow).last_active_at, locale) }}</span>
        </template>
        <template #cell-actions="{ row }">
          <Button
            variant="outline"
            size="sm"
            :loading="deletingId === (row as AssistantSessionRow).id"
            :title="t('assistant.sessions.delete')"
            @click="removeSession(row as AssistantSessionRow)"
          >
            <Trash2 class="h-4 w-4" />
          </Button>
        </template>
      </Table>
    </div>
  </div>
</template>
