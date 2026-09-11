<script setup lang="ts">
// Admin Access — the per-file/folder RBAC surface in one page: which storages
// enforce grants at all, a form to issue a new one, and every grant that
// exists. A grant is issued to an account OR to a group (see Groups) — the
// `principal` field says which, and rows written before groups existed carry
// no field at all, so absent means "user".
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Trash2, ShieldCheck } from 'lucide-vue-next';

import {
  AdminGrantsApi,
  type AdminGrant,
  type GrantLevel,
  type GrantPrincipal,
} from '@/api/grants';
import { GroupsApi, type Group } from '@/api/groups';
import { StoragesApi } from '@/api/storages';
import { UsersApi } from '@/api/users';
import type { StorageRef, User } from '@/api/types';
import { useToastStore } from '@/stores/toast';
import { extractError } from '@/api/client';
import Spinner from '@/components/ui/Spinner.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Toggle from '@/components/ui/Toggle.vue';

const PICKER_LIMIT = 10;
const SEARCH_DEBOUNCE_MS = 300;

const { t } = useI18n();
const toast = useToastStore();

const grants = ref<AdminGrant[]>([]);
const loading = ref(true);
const q = ref('');
const principalFilter = ref<'all' | GrantPrincipal>('all');

async function load() {
  loading.value = true;
  try {
    grants.value = await AdminGrantsApi.list();
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    loading.value = false;
  }
}

/** Rows older than the groups feature carry no `principal`; they are user rows. */
function principalOf(g: AdminGrant): GrantPrincipal {
  return g.principal ?? 'user';
}

/**
 * `file_grants` and `file_group_grants` have independent auto-increment ids and
 * the list endpoint merges both, so user #7 and group #7 coexist. Row identity
 * is therefore the pair, never the id alone.
 */
function rowKey(g: AdminGrant): string {
  return `${principalOf(g)}:${g.id}`;
}

/** What to call the grantee on screen and in the revoke confirmation. */
function principalName(g: AdminGrant): string {
  if (principalOf(g) === 'group') return g.group_name || `#${g.group_id}`;
  return g.user_email || g.user_display_name || `#${g.user_id}`;
}

const filtered = computed(() => {
  const term = q.value.trim().toLowerCase();
  return grants.value.filter((g) => {
    if (principalFilter.value !== 'all' && principalOf(g) !== principalFilter.value) return false;
    if (!term) return true;
    return (
      principalName(g).toLowerCase().includes(term) ||
      g.path.toLowerCase().includes(term) ||
      g.storage_name.toLowerCase().includes(term) ||
      g.level.includes(term)
    );
  });
});

const principalFilterOptions = computed(() => [
  { value: 'all', label: t('grants.principalAll') },
  { value: 'user', label: t('grants.principalUsers') },
  { value: 'group', label: t('grants.principalGroups') },
]);

const levelOptions = computed(() =>
  (['viewer', 'editor', 'owner'] as GrantLevel[]).map((l) => ({
    value: l,
    label: t(`grants.levels.${l}`),
  })),
);

function levelTone(l: string): 'rose' | 'amber' | 'zinc' {
  if (l === 'owner') return 'rose';
  if (l === 'editor') return 'amber';
  return 'zinc';
}

async function changeLevel(g: AdminGrant, level: GrantLevel) {
  if (level === g.level) return;
  const before = g.level;
  const key = rowKey(g);
  try {
    await AdminGrantsApi.update(g.id, level, principalOf(g));
    grants.value = grants.value.map((x) => (rowKey(x) === key ? { ...x, level } : x));
    toast.success(t('grants.levelChangedOk'));
  } catch (e) {
    grants.value = grants.value.map((x) => (rowKey(x) === key ? { ...x, level: before } : x));
    toast.error(extractError(e, t('errors.generic')));
  }
}

async function revoke(g: AdminGrant) {
  if (!confirm(t('grants.revokeConfirm', { principal: principalName(g), path: g.path }))) return;
  try {
    await AdminGrantsApi.remove(g.id, principalOf(g));
    const key = rowKey(g);
    grants.value = grants.value.filter((x) => rowKey(x) !== key);
    toast.success(t('grants.revokedOk'));
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  }
}

// ── Storages: the switch that makes grants mean anything ──────────

const storages = ref<StorageRef[]>([]);
const rbacSavingId = ref<number | null>(null);

async function loadStorages() {
  try {
    storages.value = await StoragesApi.list();
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  }
}

async function toggleRbac(s: StorageRef, on: boolean) {
  rbacSavingId.value = s.id;
  try {
    const updated = await StoragesApi.update(s.id, { rbac_enabled: on });
    storages.value = storages.value.map((x) =>
      x.id === s.id ? { ...x, rbac_enabled: updated.rbac_enabled ?? on } : x,
    );
    toast.success(t('grants.rbacSavedOk', { name: s.name }));
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    rbacSavingId.value = null;
  }
}

// ── New grant ─────────────────────────────────────────────────────

const form = reactive({
  storage_id: null as number | null,
  path: '',
  is_dir: true,
  level: 'viewer' as GrantLevel,
  principal: 'user' as GrantPrincipal,
  user_id: null as number | null,
  group_id: null as number | null,
});
const creating = ref(false);
const createErr = ref<string | null>(null);

const storageOptions = computed(() => storages.value.map((s) => ({ value: s.id, label: s.name })));

const principalKindOptions = computed(() => [
  { value: 'user', label: t('grants.pickUser') },
  { value: 'group', label: t('grants.pickGroup') },
]);

const userCandidates = ref<User[]>([]);
const groupCandidates = ref<Group[]>([]);
const userQuery = ref('');
const groupQuery = ref('');
let userTimer: ReturnType<typeof setTimeout> | undefined;
let groupTimer: ReturnType<typeof setTimeout> | undefined;

const userOptions = computed(() =>
  userCandidates.value.map((u) => ({
    value: u.id,
    label: u.display_name ? `${u.email} — ${u.display_name}` : u.email,
  })),
);
const groupOptions = computed(() =>
  groupCandidates.value.map((g) => ({ value: g.id, label: g.name })),
);

async function searchUsers() {
  try {
    const page = await UsersApi.list({ q: userQuery.value.trim() || undefined, page_size: PICKER_LIMIT });
    userCandidates.value = page.items;
  } catch {
    /* the picker stays on its last answer; the form still validates server-side */
  }
}

async function searchGroups() {
  try {
    const page = await GroupsApi.list({ q: groupQuery.value.trim() || undefined, limit: PICKER_LIMIT });
    groupCandidates.value = page.groups;
  } catch {
    /* same: a missing picker must not break the rest of the page */
  }
}

watch(userQuery, () => {
  clearTimeout(userTimer);
  userTimer = setTimeout(() => void searchUsers(), SEARCH_DEBOUNCE_MS);
});
watch(groupQuery, () => {
  clearTimeout(groupTimer);
  groupTimer = setTimeout(() => void searchGroups(), SEARCH_DEBOUNCE_MS);
});

async function createGrant() {
  createErr.value = null;
  if (form.storage_id == null) return;
  const principalId = form.principal === 'group' ? form.group_id : form.user_id;
  if (principalId == null) return;
  creating.value = true;
  try {
    await AdminGrantsApi.create({
      storage_id: form.storage_id,
      path: form.path.trim().replace(/^\/+/, ''),
      is_dir: form.is_dir,
      level: form.level,
      ...(form.principal === 'group' ? { group_id: principalId } : { user_id: principalId }),
    });
    // The POST answers with the bare DB row — no principal, path, storage_name,
    // user_email or group_name — so it is not a table row. Re-read the list.
    await load();
    form.path = '';
    toast.success(t('grants.createdOk'));
  } catch (e) {
    // 400 "enable RBAC on this storage first" / 409 duplicate — the server's
    // sentence is the only useful one, so it is shown verbatim.
    createErr.value = extractError(e, t('errors.generic'));
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  void load();
  void loadStorages();
  void searchUsers();
  void searchGroups();
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold flex items-center gap-2">
          <ShieldCheck class="h-5 w-5" /> {{ t('grants.title') }}
        </h1>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('grants.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <select
          v-model="principalFilter"
          data-testid="principal-filter"
          class="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"
        >
          <option v-for="o in principalFilterOptions" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
        <input
          v-model="q"
          type="search"
          :placeholder="t('grants.search')"
          class="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm w-64 max-w-full"
        />
      </div>
    </div>

    <!-- Grants are enforced per storage. With RBAC off the storage is open to every
         authenticated account and every row below is inert for it — so the switch
         belongs on this page, not only on the storage's own form. -->
    <div class="card card-body space-y-3" data-testid="rbac-storages">
      <div>
        <h2 class="text-sm font-semibold">{{ t('grants.storagesTitle') }}</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('grants.storagesHint') }}</p>
      </div>
      <p v-if="!storages.length" class="text-sm text-zinc-500">{{ t('grants.noStorages') }}</p>
      <div v-else class="grid gap-2 sm:grid-cols-2">
        <div
          v-for="s in storages"
          :key="s.id"
          class="flex items-center justify-between gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2"
        >
          <span class="truncate text-sm">{{ s.name }}</span>
          <Toggle
            :model-value="s.rbac_enabled ?? false"
            :disabled="rbacSavingId === s.id"
            :name="`rbac-${s.id}`"
            :label="t('grants.rbac')"
            @update:model-value="(v) => toggleRbac(s, v)"
          />
        </div>
      </div>
    </div>

    <form class="card card-body space-y-3" data-testid="new-grant" @submit.prevent="createGrant">
      <h2 class="text-sm font-semibold">{{ t('grants.newTitle') }}</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <Select
          v-model="form.storage_id"
          name="grant-storage"
          :label="t('grants.storage')"
          :options="storageOptions"
          :placeholder="t('grants.storage')"
        />
        <Input
          v-model="form.path"
          name="grant-path"
          monospace
          :label="t('grants.path')"
          :hint="t('grants.pathHint')"
        />
        <Select
          v-model="form.level"
          name="grant-level"
          :label="t('grants.level')"
          :options="levelOptions"
        />
        <Select
          v-model="form.principal"
          name="grant-principal"
          :label="t('grants.principalKind')"
          :options="principalKindOptions"
        />
        <template v-if="form.principal === 'user'">
          <Input
            v-model="userQuery"
            type="search"
            name="grant-user-search"
            autocomplete="off"
            :label="t('grants.searchUsers')"
          />
          <Select
            v-model="form.user_id"
            name="grant-user"
            :label="t('grants.pickUser')"
            :options="userOptions"
            :placeholder="t('grants.searchUsers')"
          />
        </template>
        <template v-else>
          <Input
            v-model="groupQuery"
            type="search"
            name="grant-group-search"
            autocomplete="off"
            :label="t('grants.searchGroups')"
          />
          <Select
            v-model="form.group_id"
            name="grant-group"
            :label="t('grants.pickGroup')"
            :options="groupOptions"
            :placeholder="t('grants.searchGroups')"
          />
        </template>
      </div>
      <Toggle
        v-model="form.is_dir"
        name="grant-is-dir"
        :label="t('grants.isDir')"
        :description="t('grants.isDirHint')"
      />
      <p v-if="createErr" class="text-xs text-rose-600 dark:text-rose-400" data-testid="grant-error">
        {{ createErr }}
      </p>
      <div class="flex justify-end">
        <Button type="submit" size="sm" :loading="creating" data-testid="grant-submit">
          <Plus class="h-4 w-4" />
          {{ t('grants.create') }}
        </Button>
      </div>
    </form>

    <div v-if="loading" class="card card-body text-center text-zinc-500"><Spinner /></div>
    <div v-else class="card overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <th class="px-4 py-2 font-medium">{{ t('grants.principal') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('grants.storage') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('grants.path') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('grants.level') }}</th>
            <th class="px-4 py-2 font-medium text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="g in filtered"
            :key="rowKey(g)"
            class="border-b border-zinc-100 dark:border-zinc-800/60"
          >
            <td class="px-4 py-2">
              <span class="inline-flex items-center gap-2">
                <Badge
                  v-if="principalOf(g) === 'group'"
                  tone="violet"
                  size="xs"
                  :data-testid="`group-badge-${rowKey(g)}`"
                >
                  {{ t('grants.group') }}
                </Badge>
                {{ principalName(g) }}
              </span>
            </td>
            <td class="px-4 py-2">{{ g.storage_name }}</td>
            <td class="px-4 py-2 font-mono text-xs">{{ g.path_prefix || '/' }}<span v-if="g.is_dir && g.path_prefix" class="text-zinc-400">/…</span></td>
            <td class="px-4 py-2">
              <span class="inline-flex items-center gap-2">
                <Badge :tone="levelTone(g.level)">{{ g.level }}</Badge>
                <Select
                  :model-value="g.level"
                  size="sm"
                  :name="`level-${rowKey(g)}`"
                  :options="levelOptions"
                  @update:model-value="(v) => changeLevel(g, v as GrantLevel)"
                />
              </span>
            </td>
            <td class="px-4 py-2 text-right">
              <button
                class="inline-flex items-center gap-1 text-rose-600 hover:text-rose-500 text-xs"
                :data-testid="`revoke-${rowKey(g)}`"
                @click="revoke(g)"
              >
                <Trash2 class="h-3.5 w-3.5" /> {{ t('grants.revoke') }}
              </button>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="5" class="px-4 py-6 text-center text-zinc-500">{{ t('grants.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
