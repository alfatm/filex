<script setup lang="ts">
// One group: its name and description, and who is in it. Membership is edited
// one account at a time (POST/DELETE), not by replacing the whole list — two
// admins on the same group would otherwise silently undo each other.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, Plus, Save, Trash2, UsersRound } from 'lucide-vue-next';

import { extractError } from '@/api/client';
import { GroupsApi, type GroupDetail, type GroupMember } from '@/api/groups';
import { UsersApi } from '@/api/users';
import type { User, UserRole } from '@/api/types';
import { useToastStore } from '@/stores/toast';

import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Spinner from '@/components/ui/Spinner.vue';
import Table, { type Column } from '@/components/ui/Table.vue';
import Textarea from '@/components/ui/Textarea.vue';

const CANDIDATE_LIMIT = 10;
const SEARCH_DEBOUNCE_MS = 300;

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToastStore();

const id = computed(() => Number(route.params.id));
const group = ref<GroupDetail | null>(null);
const members = ref<GroupMember[]>([]);
const loading = ref(true);
const saving = ref(false);

const name = ref('');
const description = ref('');

function fill(g: GroupDetail) {
  group.value = g;
  members.value = g.members;
  name.value = g.name;
  description.value = g.description ?? '';
}

async function load() {
  loading.value = true;
  try {
    fill(await GroupsApi.get(id.value));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
    router.replace({ name: 'groups' });
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const updated = await GroupsApi.update(id.value, {
      name: name.value.trim(),
      description: description.value.trim(),
    });
    group.value = { ...updated, members: members.value };
    toast.success(t('groups.updatedOk'));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    saving.value = false;
  }
}

// ── Members ───────────────────────────────────────────────────────

function roleTone(r: UserRole): 'rose' | 'amber' | 'zinc' {
  if (r === 'admin') return 'rose';
  if (r === 'user') return 'amber';
  return 'zinc';
}

const columns = computed<Column<GroupMember>[]>(() => [
  { key: 'email', label: t('common.email') },
  { key: 'display_name', label: t('common.name') },
  { key: 'role', label: t('common.role'), cell: 'slot' },
  { key: 'actions', label: '', align: 'right', cell: 'slot', width: '80px' },
]);

const removingId = ref<number | null>(null);

async function removeMember(m: GroupMember) {
  if (!window.confirm(t('groups.removeMemberConfirm', { email: m.email }))) return;
  removingId.value = m.id;
  try {
    await GroupsApi.removeMember(id.value, m.id);
    members.value = members.value.filter((x) => x.id !== m.id);
    toast.success(t('groups.memberRemovedOk'));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    removingId.value = null;
  }
}

const candidateQuery = ref('');
const candidates = ref<User[]>([]);
const pickedId = ref<number | null>(null);
const adding = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** Accounts that are not already in the group — the API has no "exclude" filter. */
const candidateOptions = computed(() => {
  const inGroup = new Set(members.value.map((m) => m.id));
  return candidates.value
    .filter((u) => !inGroup.has(u.id))
    .map((u) => ({ value: u.id, label: u.display_name ? `${u.email} — ${u.display_name}` : u.email }));
});

async function searchUsers() {
  try {
    const page = await UsersApi.list({
      q: candidateQuery.value.trim() || undefined,
      page_size: CANDIDATE_LIMIT,
    });
    candidates.value = page.items;
    if (!candidateOptions.value.some((o) => o.value === pickedId.value)) {
      pickedId.value = candidateOptions.value[0]?.value ?? null;
    }
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  }
}

watch(candidateQuery, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void searchUsers(), SEARCH_DEBOUNCE_MS);
});

async function addMember() {
  if (pickedId.value == null) return;
  adding.value = true;
  try {
    await GroupsApi.addMember(id.value, pickedId.value);
    // The add endpoint answers no body; re-read so the row carries the
    // account's real name and role rather than what the picker happened to show.
    fill(await GroupsApi.get(id.value));
    pickedId.value = null;
    toast.success(t('groups.memberAddedOk'));
    void searchUsers();
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    adding.value = false;
  }
}

onMounted(() => {
  void load();
  void searchUsers();
});
</script>

<template>
  <div
    v-if="loading"
    class="card card-body text-center text-zinc-500"
  >
    <Spinner />
  </div>
  <div
    v-else-if="group"
    class="space-y-5 max-w-3xl"
  >
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold flex items-center gap-2">
          <UsersRound class="h-5 w-5" />
          {{ group.name }}
        </h1>
        <p class="text-sm text-zinc-500">
          {{ group.description || t('groups.subtitle') }}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        @click="router.push({ name: 'groups' })"
      >
        <ArrowLeft class="h-4 w-4" />
        {{ t('common.back') }}
      </Button>
    </div>

    <form
      class="card card-body space-y-3"
      data-testid="group-form"
      @submit.prevent="save"
    >
      <Input
        v-model="name"
        name="group-name"
        :label="t('groups.fields.name')"
        required
      />
      <Textarea
        v-model="description"
        name="group-description"
        :label="t('groups.fields.description')"
        :hint="t('common.optional')"
      />
      <div class="flex justify-end">
        <Button
          type="submit"
          :loading="saving"
          data-testid="group-save"
        >
          <Save class="h-4 w-4" />
          {{ t('common.save') }}
        </Button>
      </div>
    </form>

    <div class="space-y-3">
      <h2 class="text-sm font-semibold">
        {{ t('groups.membersTitle') }}
      </h2>

      <Table
        :columns="columns"
        :rows="members"
        :empty="t('groups.noMembers')"
        row-key="id"
      >
        <template #cell-role="{ row }">
          <Badge
            :tone="roleTone((row as GroupMember).role)"
            size="xs"
          >
            {{ (row as GroupMember).role }}
          </Badge>
        </template>
        <template #cell-actions="{ row }">
          <Button
            variant="ghost"
            size="xs"
            :loading="removingId === (row as GroupMember).id"
            :title="t('common.remove')"
            data-testid="member-remove"
            @click="removeMember(row as GroupMember)"
          >
            <Trash2 class="h-3.5 w-3.5 text-rose-500" />
          </Button>
        </template>
      </Table>

      <div
        class="card card-body space-y-3"
        data-testid="add-member"
      >
        <h3 class="text-sm font-semibold">
          {{ t('groups.addMember') }}
        </h3>
        <div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Input
            v-model="candidateQuery"
            type="search"
            name="member-search"
            :placeholder="t('groups.searchUsers')"
            autocomplete="off"
          />
          <Select
            v-model="pickedId"
            name="member-pick"
            :options="candidateOptions"
            :placeholder="t('groups.noCandidates')"
          />
          <Button
            type="button"
            :disabled="pickedId == null"
            :loading="adding"
            data-testid="member-add"
            @click="addMember"
          >
            <Plus class="h-4 w-4" />
            {{ t('common.add') }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
