<script setup lang="ts">
/**
 * Roles: one matrix of file operations (rows, grouped) against roles
 * (columns). The admin column is shown fully checked and disabled — it always
 * has everything, and the server refuses to change it — while each editable
 * role is saved on its own, so a half-finished column is never sent.
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Save, UserCog } from 'lucide-vue-next';

import { extractError } from '@/api/client';
import { RolesApi, type RoleCatalogueOp, type RoleOpGroup, type RoleRow } from '@/api/roles';
import { useToastStore } from '@/stores/toast';

import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Spinner from '@/components/ui/Spinner.vue';

const { t, te } = useI18n();
const toast = useToastStore();

const roles = ref<RoleRow[]>([]);
const catalogue = ref<RoleCatalogueOp[]>([]);
const loading = ref(true);
const savingRole = ref<string | null>(null);
/** What is being edited, per role; `roles` keeps the server's copy for the dirty check. */
const draft = ref<Record<string, string[]>>({});

function fill(res: { roles: RoleRow[]; catalogue: RoleCatalogueOp[] }) {
  roles.value = res.roles;
  catalogue.value = res.catalogue;
  draft.value = Object.fromEntries(res.roles.map((r) => [r.name, [...r.permissions]]));
}

async function load() {
  loading.value = true;
  try {
    fill(await RolesApi.list());
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    loading.value = false;
  }
}

/** Catalogue rows grouped in the order the server lists the groups. */
const groups = computed<{ group: RoleOpGroup; ops: RoleCatalogueOp[] }[]>(() => {
  const out: { group: RoleOpGroup; ops: RoleCatalogueOp[] }[] = [];
  for (const op of catalogue.value) {
    const g = out.find((x) => x.group === op.group);
    if (g) g.ops.push(op);
    else out.push({ group: op.group, ops: [op] });
  }
  return out;
});

function has(role: RoleRow, op: string): boolean {
  if (!role.editable) return true;
  return draft.value[role.name]?.includes(op) ?? false;
}

function setOp(role: RoleRow, op: string, on: boolean) {
  const current = draft.value[role.name] ?? [];
  draft.value[role.name] = on ? [...current, op] : current.filter((p) => p !== op);
}

function dirty(role: RoleRow): boolean {
  const a = [...(draft.value[role.name] ?? [])].sort();
  const b = [...role.permissions].sort();
  return a.length !== b.length || a.some((p, i) => p !== b[i]);
}

async function save(role: RoleRow) {
  savingRole.value = role.name;
  try {
    // Sent in catalogue order so the stored list reads the same as the matrix.
    const wanted = new Set(draft.value[role.name] ?? []);
    const permissions = catalogue.value.map((op) => op.id).filter((id) => wanted.has(id));
    const saved = await RolesApi.update(role.name, permissions);
    roles.value = roles.value.map((r) => (r.name === role.name ? saved : r));
    draft.value[role.name] = [...saved.permissions];
    toast.success(t('roles.savedOk', { name: roleLabel(role.name) }));
  } catch (e: unknown) {
    toast.error(extractError(e, t('errors.generic')));
  } finally {
    savingRole.value = null;
  }
}

function roleLabel(name: string): string {
  const key = `users.roles.${name}`;
  return te(key) ? t(key) : name;
}

function opLabel(id: string): string {
  const key = `roles.ops.${id}.label`;
  return te(key) ? t(key) : id;
}

function opHint(id: string): string {
  const key = `roles.ops.${id}.hint`;
  return te(key) ? t(key) : '';
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2">
        <UserCog class="h-5 w-5 text-brand-600 dark:text-brand-400" />
        {{ t('roles.title') }}
      </h1>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        {{ t('roles.subtitle') }}
      </p>
    </div>

    <div
      v-if="loading"
      class="card card-body text-center text-zinc-500"
    >
      <Spinner />
    </div>
    <div
      v-else-if="!roles.length"
      class="card card-body text-center text-sm text-zinc-500"
    >
      {{ t('roles.empty') }}
    </div>
    <div
      v-else
      class="card overflow-x-auto"
    >
      <table
        class="w-full text-sm"
        data-testid="roles-matrix"
      >
        <thead class="text-left text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <th class="px-4 py-2 font-medium">
              {{ t('roles.operation') }}
            </th>
            <th
              v-for="role in roles"
              :key="role.name"
              class="px-4 py-2 font-medium text-center align-top"
              :data-testid="`role-col-${role.name}`"
            >
              <div class="flex flex-col items-center gap-1">
                <span class="text-zinc-800 dark:text-zinc-100">{{ roleLabel(role.name) }}</span>
                <span
                  v-if="!role.editable"
                  class="text-xs font-normal text-zinc-400"
                >{{ t('roles.adminHint') }}</span>
                <template v-else>
                  <Button
                    size="xs"
                    :variant="dirty(role) ? 'primary' : 'outline'"
                    :disabled="!dirty(role)"
                    :loading="savingRole === role.name"
                    :data-testid="`save-role-${role.name}`"
                    @click="save(role)"
                  >
                    <Save class="h-3.5 w-3.5" />
                    {{ t('common.save') }}
                  </Button>
                  <Badge
                    v-if="dirty(role)"
                    tone="amber"
                    size="xs"
                  >
                    {{ t('roles.unsaved') }}
                  </Badge>
                </template>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <template
            v-for="g in groups"
            :key="g.group"
          >
            <tr class="bg-zinc-50 dark:bg-zinc-900/50">
              <th
                :colspan="roles.length + 1"
                class="px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500"
                scope="rowgroup"
              >
                {{ t(`roles.groups.${g.group}`) }}
              </th>
            </tr>
            <tr
              v-for="op in g.ops"
              :key="op.id"
              class="border-b border-zinc-100 dark:border-zinc-800/60"
              :data-testid="`op-${op.id}`"
            >
              <td class="px-4 py-2">
                <div>{{ opLabel(op.id) }}</div>
                <div
                  v-if="opHint(op.id)"
                  class="text-xs text-zinc-500 dark:text-zinc-400"
                >
                  {{ opHint(op.id) }}
                </div>
              </td>
              <td
                v-for="role in roles"
                :key="role.name"
                class="px-4 py-2 text-center"
              >
                <span class="inline-flex justify-center">
                  <Checkbox
                    :model-value="has(role, op.id)"
                    :disabled="!role.editable"
                    :name="`perm-${role.name}-${op.id}`"
                    @update:model-value="(v) => setOp(role, op.id, v)"
                  />
                </span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
