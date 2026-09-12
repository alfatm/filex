<script setup lang="ts">
/**
 * Quotas: one default for every account, and the per-account overrides laid
 * over it. An override is tri-state — inherit the default, unlimited, or a
 * limit of its own — and the table shows which of the two applies to each
 * cell so an operator can tell a default from a deliberate exception.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Gauge, Pencil, RefreshCcw, Save, X } from 'lucide-vue-next';

import { extractError } from '@/api/client';
import {
  OVERRIDE_INHERIT,
  OVERRIDE_UNLIMITED,
  QuotasApi,
  type QuotaDefaults,
  type QuotaUserRow,
  type UserQuotaSnapshot,
} from '@/api/quotas';
import type { UserRole } from '@/api/types';
import { formatBytes, formatNumber } from '@/lib/format';
import { useToastStore } from '@/stores/toast';

import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Spinner from '@/components/ui/Spinner.vue';
import Table, { type Column } from '@/components/ui/Table.vue';

// GB inputs use the same 1000-base as formatBytes so "10 GB" typed here is
// the "10 GB" the table renders (same convention as Users → edit).
const GB = 1_000_000_000;
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const WINDOW_HOURS_MIN = 1;
const WINDOW_HOURS_MAX = 720;

const { t, locale } = useI18n();
const toast = useToastStore();

/**
 * Bytes are the model; GB is only how the input renders them. The division is
 * left lossless on purpose: rounding to two decimals turned 2 MB into `0` —
 * i.e. "unlimited" — and drifted every value that is not a whole number of GB.
 */
function toGb(bytes: number): number {
  return bytes > 0 ? bytes / GB : 0;
}

/**
 * Back to bytes. A positive limit must never land on 0, which on this surface
 * means unlimited (defaults) or inherit (overrides).
 */
function toBytes(value: number, unit: number): number {
  const bytes = Math.round(value * unit);
  return value > 0 ? Math.max(1, bytes) : bytes;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ── Defaults ──────────────────────────────────────────────────────

const defaults = ref<QuotaDefaults | null>(null);
const loadingDefaults = ref(true);
const savingDefaults = ref(false);
const defaultsErr = ref<string | null>(null);
/** A tenant admin: the defaults are the platform operator's, one for the whole instance. */
const forbidden = ref(false);

const defaultsForm = reactive({ storageGb: 0, files: 0, uploadGb: 0, windowHours: 24 });

function fillDefaults(d: QuotaDefaults) {
  defaults.value = d;
  defaultsForm.storageGb = toGb(d.quota_bytes);
  defaultsForm.files = d.quota_files;
  defaultsForm.uploadGb = toGb(d.upload_bytes);
  defaultsForm.windowHours = d.upload_window_hours;
}

function is403(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 403;
}

async function loadDefaults() {
  loadingDefaults.value = true;
  try {
    fillDefaults(await QuotasApi.getDefaults());
  } catch (e: unknown) {
    if (is403(e)) forbidden.value = true;
    else toast.error(extractError(e, t('errors.generic')));
  } finally {
    loadingDefaults.value = false;
  }
}

async function saveDefaults() {
  defaultsErr.value = null;
  const f = defaultsForm;
  const windowOk =
    isCount(f.windowHours) && f.windowHours >= WINDOW_HOURS_MIN && f.windowHours <= WINDOW_HOURS_MAX;
  if (!isCount(f.storageGb) || !isCount(f.files) || !isCount(f.uploadGb) || !windowOk) {
    defaultsErr.value = t('quotas.defaults.errInvalid');
    return;
  }
  savingDefaults.value = true;
  try {
    fillDefaults(
      await QuotasApi.updateDefaults({
        quota_bytes: toBytes(f.storageGb, GB),
        quota_files: toBytes(f.files, 1),
        upload_bytes: toBytes(f.uploadGb, GB),
        upload_window_hours: Math.round(f.windowHours),
      }),
    );
    toast.success(t('quotas.defaults.savedOk'));
    // Effective values in the table follow the defaults; refresh what is shown.
    void loadUsers();
  } catch (e: unknown) {
    defaultsErr.value = extractError(e, t('errors.generic'));
  } finally {
    savingDefaults.value = false;
  }
}

// ── Accounts ──────────────────────────────────────────────────────

const rows = ref<QuotaUserRow[]>([]);
const total = ref(0);
const page = ref(1);
const q = ref('');
const loadingUsers = ref(true);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function loadUsers() {
  loadingUsers.value = true;
  try {
    const res = await QuotasApi.listUsers({
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
      q: q.value.trim(),
    });
    rows.value = res.users;
    total.value = res.total;
  } catch (e: unknown) {
    if (is403(e)) forbidden.value = true;
    else toast.error(extractError(e, t('errors.generic')));
  } finally {
    loadingUsers.value = false;
  }
}

watch(q, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void loadUsers();
  }, SEARCH_DEBOUNCE_MS);
});

function goPage(p: number) {
  page.value = p;
  void loadUsers();
}

function roleTone(r: UserRole): 'rose' | 'amber' | 'zinc' {
  if (r === 'admin') return 'rose';
  if (r === 'user') return 'amber';
  return 'zinc';
}

function percent(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
}

function barClass(p: number): string {
  if (p >= 90) return 'bg-rose-500';
  if (p >= 75) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/** Whether the cell's limit is the instance default or this account's own. */
function sourceLabel(override: number): string {
  return override === OVERRIDE_INHERIT ? t('quotas.accounts.default') : t('quotas.accounts.override');
}

function bytesLimit(effective: number): string {
  return effective > 0 ? formatBytes(effective, locale.value) : t('quota.unlimited');
}

function countLimit(effective: number): string {
  return effective > 0 ? formatNumber(effective, locale.value) : t('quota.unlimited');
}

/** Re-reads one account after a change; the list endpoint would re-page everything. */
async function refreshRow(id: number) {
  const snap: UserQuotaSnapshot = await QuotasApi.getUser(id);
  const idx = rows.value.findIndex((r) => r.id === id);
  if (idx < 0) return;
  rows.value[idx] = {
    ...rows.value[idx],
    overrides: snap.overrides,
    effective: {
      quota_bytes: snap.quota_bytes,
      quota_files: snap.quota_files,
      upload_bytes: snap.upload_quota_bytes,
    },
    used_bytes: snap.used_bytes,
    used_files: snap.used_files,
    upload_used_bytes: snap.upload_used_bytes,
  };
}

const recomputingId = ref<number | null>(null);

async function recompute(row: QuotaUserRow) {
  recomputingId.value = row.id;
  try {
    await QuotasApi.recomputeUser(row.id);
    await refreshRow(row.id);
    toast.success(t('quotas.accounts.recomputeOk', { email: row.email }));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    recomputingId.value = null;
  }
}

// ── Inline editor ─────────────────────────────────────────────────

type OverrideMode = 'inherit' | 'unlimited' | 'custom';
interface OverrideField {
  mode: OverrideMode;
  /** The custom value as typed: GB for byte limits, a count for files. */
  value: number;
}

const editing = ref<QuotaUserRow | null>(null);
const editor = reactive<{ storage: OverrideField; files: OverrideField; upload: OverrideField }>({
  storage: { mode: 'inherit', value: 0 },
  files: { mode: 'inherit', value: 0 },
  upload: { mode: 'inherit', value: 0 },
});
const editorErr = ref<string | null>(null);
const savingEditor = ref(false);

function decode(override: number, unit: number): OverrideField {
  if (override === OVERRIDE_UNLIMITED) return { mode: 'unlimited', value: 0 };
  if (override === OVERRIDE_INHERIT) return { mode: 'inherit', value: 0 };
  return { mode: 'custom', value: override / unit };
}

/** Back to the wire's tri-state; `null` when a custom value is not a positive number. */
function encode(field: OverrideField, unit: number): number | null {
  if (field.mode === 'unlimited') return OVERRIDE_UNLIMITED;
  if (field.mode === 'inherit') return OVERRIDE_INHERIT;
  if (!isCount(field.value) || field.value <= 0) return null;
  return toBytes(field.value, unit);
}

function openEditor(row: QuotaUserRow) {
  editing.value = row;
  editorErr.value = null;
  Object.assign(editor.storage, decode(row.overrides.quota_bytes, GB));
  Object.assign(editor.files, decode(row.overrides.quota_files, 1));
  Object.assign(editor.upload, decode(row.overrides.quota_upload_bytes, GB));
}

function closeEditor() {
  editing.value = null;
}

async function saveEditor() {
  const row = editing.value;
  if (!row) return;
  editorErr.value = null;
  const quota_bytes = encode(editor.storage, GB);
  const quota_files = encode(editor.files, 1);
  const quota_upload_bytes = encode(editor.upload, GB);
  if (quota_bytes == null || quota_files == null || quota_upload_bytes == null) {
    editorErr.value = t('quotas.editor.errCustom');
    return;
  }
  savingEditor.value = true;
  try {
    await QuotasApi.updateUser(row.id, { quota_bytes, quota_files, quota_upload_bytes });
    await refreshRow(row.id);
    toast.success(t('quotas.accounts.savedOk', { email: row.email }));
    closeEditor();
  } catch (e: unknown) {
    editorErr.value = extractError(e, t('errors.generic'));
  } finally {
    savingEditor.value = false;
  }
}

function modeOptions(defaultText: string) {
  return [
    { value: 'inherit', label: t('quotas.editor.inherit', { value: defaultText }) },
    { value: 'unlimited', label: t('quotas.editor.unlimited') },
    { value: 'custom', label: t('quotas.editor.custom') },
  ];
}

const storageModeOptions = computed(() => modeOptions(bytesLimit(defaults.value?.quota_bytes ?? 0)));
const filesModeOptions = computed(() => modeOptions(countLimit(defaults.value?.quota_files ?? 0)));
const uploadModeOptions = computed(() => modeOptions(bytesLimit(defaults.value?.upload_bytes ?? 0)));

const columns = computed<Column<QuotaUserRow>[]>(() => [
  { key: 'email', label: t('quotas.accounts.account'), cell: 'slot' },
  { key: 'role', label: t('common.role'), cell: 'slot' },
  { key: 'used_bytes', label: t('quotas.accounts.storage'), cell: 'slot', width: '22%' },
  { key: 'used_files', label: t('quotas.accounts.files'), cell: 'slot' },
  { key: 'upload_used_bytes', label: t('quotas.accounts.upload'), cell: 'slot' },
  { key: 'actions', label: '', align: 'right', cell: 'slot' },
]);

onMounted(() => {
  void loadDefaults();
  void loadUsers();
});
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2">
        <Gauge class="h-5 w-5 text-brand-600 dark:text-brand-400" />
        {{ t('quotas.title') }}
      </h1>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('quotas.subtitle') }}
      </p>
    </div>

    <!-- A tenant admin gets 403: quotas are one setting for the whole instance and belong to the
         platform operator. Saying so beats two cards whose every button answers 403. -->
    <div
      v-if="forbidden"
      class="card card-body text-sm text-zinc-600 dark:text-zinc-400"
      data-testid="quotas-forbidden"
    >
      {{ t('quotas.supertenantOnly') }}
    </div>

    <template v-else>
      <div
        v-if="loadingDefaults"
        class="card card-body text-center text-zinc-500"
      >
        <Spinner />
      </div>
      <form
        v-else
        class="card card-body space-y-3 max-w-3xl"
        data-testid="quotas-defaults"
        @submit.prevent="saveDefaults"
      >
        <div>
          <h2 class="text-sm font-semibold">
            {{ t('quotas.defaults.title') }}
          </h2>
          <p class="text-sm text-zinc-500 dark:text-zinc-400">
            {{ t('quotas.defaults.subtitle') }}
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <Input
            v-model.number="defaultsForm.storageGb"
            type="number"
            name="defaults-storage"
            :min="0"
            step="any"
            :label="t('quotas.defaults.storage')"
            :hint="t('quotas.defaults.zeroUnlimited')"
          />
          <Input
            v-model.number="defaultsForm.files"
            type="number"
            name="defaults-files"
            :min="0"
            :step="1"
            :label="t('quotas.defaults.files')"
            :hint="t('quotas.defaults.zeroUnlimited')"
          />
          <Input
            v-model.number="defaultsForm.uploadGb"
            type="number"
            name="defaults-upload"
            :min="0"
            step="any"
            :label="t('quotas.defaults.upload')"
            :hint="t('quotas.defaults.zeroUnlimited')"
          />
          <Input
            v-model.number="defaultsForm.windowHours"
            type="number"
            name="defaults-window"
            :min="WINDOW_HOURS_MIN"
            :max="WINDOW_HOURS_MAX"
            :step="1"
            :label="t('quotas.defaults.window')"
            :hint="t('quotas.defaults.windowHint')"
          />
        </div>
        <p
          v-if="defaultsErr"
          class="text-xs text-rose-600 dark:text-rose-400"
        >
          {{ defaultsErr }}
        </p>
        <div class="flex justify-end">
          <Button
            type="submit"
            size="sm"
            :loading="savingDefaults"
          >
            <Save class="h-4 w-4" />
            {{ t('common.save') }}
          </Button>
        </div>
      </form>

      <div class="space-y-3">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h2 class="text-sm font-semibold">
            {{ t('quotas.accounts.title') }}
          </h2>
          <input
            v-model="q"
            type="search"
            :placeholder="t('quotas.accounts.search')"
            class="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm w-64 max-w-full"
          />
        </div>

        <Table
          :columns="columns"
          :rows="rows"
          :loading="loadingUsers"
          :empty="t('quotas.accounts.empty')"
          row-key="id"
          :page="page"
          :page-size="PAGE_SIZE"
          :total="total"
          @page="goPage"
        >
          <template #cell-email="{ row }">
            <div class="leading-tight">
              <div>{{ (row as QuotaUserRow).email }}</div>
              <div
                v-if="(row as QuotaUserRow).display_name"
                class="text-xs text-zinc-500"
              >
                {{ (row as QuotaUserRow).display_name }}
              </div>
            </div>
          </template>
          <template #cell-role="{ row }">
            <Badge
              :tone="roleTone((row as QuotaUserRow).role)"
              size="xs"
            >
              {{ (row as QuotaUserRow).role }}
            </Badge>
          </template>
          <template #cell-used_bytes="{ row }">
            <div class="space-y-1 min-w-[10rem]">
              <div class="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                <span>
                  {{ formatBytes((row as QuotaUserRow).used_bytes, locale) }} /
                  {{ bytesLimit((row as QuotaUserRow).effective.quota_bytes) }}
                </span>
                <span
                  class="text-[10px] uppercase tracking-wide text-zinc-400"
                  data-testid="source-bytes"
                >{{ sourceLabel((row as QuotaUserRow).overrides.quota_bytes) }}</span>
              </div>
              <div
                v-if="(row as QuotaUserRow).effective.quota_bytes > 0"
                class="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
                aria-hidden="true"
              >
                <span
                  class="absolute inset-y-0 left-0"
                  :class="barClass(percent((row as QuotaUserRow).used_bytes, (row as QuotaUserRow).effective.quota_bytes))"
                  :style="{ width: `${percent((row as QuotaUserRow).used_bytes, (row as QuotaUserRow).effective.quota_bytes)}%` }"
                />
              </div>
            </div>
          </template>
          <template #cell-used_files="{ row }">
            <div class="text-xs tabular-nums whitespace-nowrap">
              {{ formatNumber((row as QuotaUserRow).used_files, locale) }} /
              {{ countLimit((row as QuotaUserRow).effective.quota_files) }}
              <span
                class="ml-1 text-[10px] uppercase tracking-wide text-zinc-400"
                data-testid="source-files"
              >{{ sourceLabel((row as QuotaUserRow).overrides.quota_files) }}</span>
            </div>
          </template>
          <template #cell-upload_used_bytes="{ row }">
            <div class="text-xs tabular-nums whitespace-nowrap">
              {{ formatBytes((row as QuotaUserRow).upload_used_bytes, locale) }} /
              {{ bytesLimit((row as QuotaUserRow).effective.upload_bytes) }}
              <span
                class="ml-1 text-[10px] uppercase tracking-wide text-zinc-400"
                data-testid="source-upload"
              >{{ sourceLabel((row as QuotaUserRow).overrides.quota_upload_bytes) }}</span>
            </div>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex items-center justify-end gap-1">
              <Button
                variant="outline"
                size="xs"
                :title="t('common.edit')"
                data-testid="edit-row"
                @click="openEditor(row as QuotaUserRow)"
              >
                <Pencil class="h-3.5 w-3.5" />
                {{ t('common.edit') }}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                :loading="recomputingId === (row as QuotaUserRow).id"
                :title="t('quotas.accounts.recompute')"
                data-testid="recompute-row"
                @click="recompute(row as QuotaUserRow)"
              >
                <RefreshCcw class="h-3.5 w-3.5" />
                {{ t('quotas.accounts.recompute') }}
              </Button>
            </div>
          </template>
        </Table>

        <form
          v-if="editing"
          class="card card-body space-y-3 max-w-3xl"
          data-testid="quota-editor"
          @submit.prevent="saveEditor"
        >
          <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-semibold">
              {{ t('quotas.editor.title', { email: editing.email }) }}
            </h3>
            <button
              type="button"
              class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              :title="t('common.close')"
              @click="closeEditor"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="space-y-2">
              <Select
                v-model="editor.storage.mode"
                name="edit-storage-mode"
                :label="t('quotas.editor.storage')"
                :options="storageModeOptions"
              />
              <Input
                v-if="editor.storage.mode === 'custom'"
                v-model.number="editor.storage.value"
                type="number"
                name="edit-storage-value"
                :min="0"
                step="any"
                :hint="t('quotas.editor.customGb')"
              />
            </div>
            <div class="space-y-2">
              <Select
                v-model="editor.files.mode"
                name="edit-files-mode"
                :label="t('quotas.editor.files')"
                :options="filesModeOptions"
              />
              <Input
                v-if="editor.files.mode === 'custom'"
                v-model.number="editor.files.value"
                type="number"
                name="edit-files-value"
                :min="0"
                :step="1"
                :hint="t('quotas.editor.customCount')"
              />
            </div>
            <div class="space-y-2">
              <Select
                v-model="editor.upload.mode"
                name="edit-upload-mode"
                :label="t('quotas.editor.upload')"
                :options="uploadModeOptions"
              />
              <Input
                v-if="editor.upload.mode === 'custom'"
                v-model.number="editor.upload.value"
                type="number"
                name="edit-upload-value"
                :min="0"
                step="any"
                :hint="t('quotas.editor.customGb')"
              />
            </div>
          </div>
          <p
            v-if="editorErr"
            class="text-xs text-rose-600 dark:text-rose-400"
          >
            {{ editorErr }}
          </p>
          <div class="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              @click="closeEditor"
            >
              {{ t('common.cancel') }}
            </Button>
            <Button
              type="submit"
              size="sm"
              :loading="savingEditor"
              data-testid="quota-editor-save"
            >
              <Save class="h-4 w-4" />
              {{ t('common.save') }}
            </Button>
          </div>
        </form>
      </div>
    </template>
  </div>
</template>
