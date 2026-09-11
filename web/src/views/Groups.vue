<script setup lang="ts">
// Admin Groups — tenant-scoped user groups. A group is a principal for RBAC
// grants (Access page), so deleting one also revokes every grant issued to it.
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Plus, Trash2, Pencil, RefreshCcw, UsersRound } from 'lucide-vue-next';

import { GroupsApi, type Group } from '@/api/groups';
import { useToastStore } from '@/stores/toast';
import { extractError } from '@/api/client';
import { formatRelative } from '@/lib/format';

import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Textarea from '@/components/ui/Textarea.vue';
import Modal from '@/components/ui/Modal.vue';
import Table, { type Column } from '@/components/ui/Table.vue';

const PAGE_SIZE = 25;

const { t, locale } = useI18n();
const router = useRouter();
const toast = useToastStore();

const groups = ref<Group[]>([]);
const total = ref(0);
const loading = ref(true);
const q = ref('');
const page = ref(1);

const showCreate = ref(false);
const newName = ref('');
const newDescription = ref('');
const creating = ref(false);

const showDelete = ref<Group | null>(null);
const deleting = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await GroupsApi.list({
      q: q.value.trim() || undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    });
    groups.value = res.groups;
    total.value = res.total;
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    loading.value = false;
  }
}

watch(q, () => {
  page.value = 1;
  load();
});

onMounted(load);

const columns = computed<Column<Group>[]>(() => [
  { key: 'name', label: t('common.name') },
  { key: 'description', label: t('groups.fields.description') },
  { key: 'member_count', label: t('groups.members'), align: 'right' },
  { key: 'created_at', label: t('common.created'), cell: 'slot' },
  { key: 'actions', label: t('common.actions'), cell: 'slot', align: 'right', width: '120px' },
]);

async function submitCreate() {
  const name = newName.value.trim();
  if (!name) return;
  creating.value = true;
  try {
    await GroupsApi.create({ name, description: newDescription.value.trim() });
    toast.success(t('groups.createdOk'));
    showCreate.value = false;
    newName.value = '';
    newDescription.value = '';
    await load();
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    creating.value = false;
  }
}

async function confirmDelete() {
  if (!showDelete.value) return;
  deleting.value = true;
  try {
    await GroupsApi.remove(showDelete.value.id);
    toast.success(t('groups.deletedOk'));
    showDelete.value = null;
    await load();
  } catch (e) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold flex items-center gap-2">
          <UsersRound class="h-5 w-5" /> {{ t('groups.title') }}
        </h1>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">{{ t('groups.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="load" :loading="loading">
          <RefreshCcw class="h-4 w-4" />
          {{ t('common.refresh') }}
        </Button>
        <Button data-testid="groups-new" @click="showCreate = true">
          <Plus class="h-4 w-4" />
          {{ t('groups.addNew') }}
        </Button>
      </div>
    </div>

    <Table
      :columns="columns"
      :rows="groups"
      :loading="loading"
      :empty="t('groups.empty')"
      :page="page"
      :page-size="PAGE_SIZE"
      :total="total"
      row-key="id"
      @page="(p) => ((page = p), load())"
    >
      <template #toolbar>
        <Input
          v-model="q"
          :placeholder="t('groups.search')"
          size="sm"
          class="w-60"
          autocomplete="off"
        />
      </template>

      <template #cell-created_at="{ row }">
        <span class="text-xs text-zinc-500">{{
          formatRelative((row as Group).created_at, locale)
        }}</span>
      </template>

      <template #cell-actions="{ row }">
        <div class="flex items-center justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            :title="t('common.edit')"
            @click="router.push({ name: 'groups.edit', params: { id: (row as Group).id } })"
          >
            <Pencil class="h-3.5 w-3.5" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            :title="t('common.delete')"
            @click="showDelete = row as Group"
          >
            <Trash2 class="h-3.5 w-3.5 text-rose-500" />
          </Button>
        </div>
      </template>
    </Table>

    <Modal v-model="showCreate" :title="t('groups.newTitle')" size="md">
      <form class="space-y-3" @submit.prevent="submitCreate">
        <Input v-model="newName" :label="t('common.name')" name="group-name" required />
        <Textarea
          v-model="newDescription"
          :label="t('groups.fields.description')"
          name="group-description"
          :hint="t('common.optional')"
        />
      </form>
      <template #footer>
        <Button variant="ghost" @click="showCreate = false">{{ t('common.cancel') }}</Button>
        <Button data-testid="groups-create-submit" :loading="creating" @click="submitCreate">
          {{ t('common.create') }}
        </Button>
      </template>
    </Modal>

    <Modal
      :model-value="showDelete !== null"
      :title="t('common.delete')"
      size="sm"
      @update:model-value="(v) => (v ? null : (showDelete = null))"
    >
      <p class="text-sm">{{ t('groups.deleteConfirm', { name: showDelete?.name }) }}</p>
      <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{{ t('groups.deleteHint') }}</p>
      <template #footer>
        <Button variant="ghost" @click="showDelete = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="deleting" @click="confirmDelete">
          {{ t('common.yesDelete') }}
        </Button>
      </template>
    </Modal>
  </div>
</template>
