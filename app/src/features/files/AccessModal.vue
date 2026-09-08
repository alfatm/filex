<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { UserMinus } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node, Person } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { Avatar, Button, IconButton, Input, Select } from '@/ui';
import Modal from '@/ui/Modal.vue';

/** Who can see a node, and as what. The link itself lives in the share modal; this is the people side. */
const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const files = useFilesStore();

const GRANTABLE = ['editor', 'viewer'] as const;

const people = ref<Person[]>([]);
/** A viewer may see who else has access; only an owner may change it, so for everyone else this is a list. */
const canManage = ref(false);
const email = ref('');
const role = ref<(typeof GRANTABLE)[number]>('viewer');
const input = ref<InstanceType<typeof Input>>();

const roleOptions = computed(() => GRANTABLE.map((value) => ({ value, label: t(`panel.role.${value}`) })));
/** An address, roughly: enough to catch a typo, not enough to argue about the RFC. */
const valid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()));

async function load() {
  const access = await repository.listPeople(props.node.id);
  people.value = access.people;
  canManage.value = access.canManage;
  // The details panel shows the same list.
  await files.refresh();
}

onMounted(load);

async function invite() {
  if (!valid.value) return;
  await repository.addPerson(props.node.id, email.value, role.value);
  email.value = '';
  await load();
}

async function changeRole(person: Person, next: string) {
  await repository.setPersonRole(props.node.id, person.id, next as Person['role']);
  await load();
}

async function revoke(person: Person) {
  await repository.removePerson(props.node.id, person.id);
  await load();
}
</script>

<template>
  <Modal :title="t('modal.access.title')" :close-label="t('modal.close')" :width="560" :initial-focus="input?.el" @close="emit('close')">
    <p class="text-14 leading-tight text-text-3">{{ t('modal.access.hint', { name: node.name }) }}</p>

    <form v-if="canManage" class="mt-4 flex gap-3" @submit.prevent="invite">
      <Input
        ref="input"
        v-model="email"
        class="flex-1"
        :height="44"
        :placeholder="t('modal.access.emailPlaceholder')"
        :label="t('modal.access.email')"
        @enter="invite"
      />
      <Select v-model="role" :options="roleOptions" :width="132" :label="t('modal.access.role')" class="!h-11" />
      <Button type="submit" :disabled="!valid" class="!h-11 disabled:opacity-50">{{ t('modal.access.invite') }}</Button>
    </form>

    <ul class="mt-5 divide-y divide-border-soft" :aria-label="t('modal.access.people')">
      <li v-for="person in people" :key="person.id" class="flex h-[58px] items-center">
        <Avatar :initial="person.initial" />
        <div class="ml-3 min-w-0 flex-1">
          <p class="truncate-safe text-15 leading-none">{{ person.id === files.user?.id ? t('panel.you') : person.name }}</p>
          <p class="mt-1.5 truncate-safe text-13 leading-none text-text-3">{{ person.id }}</p>
        </div>
        <!-- The owner's role is not a permission anyone can hand out, so that row is read-only — and for a caller
             who may not manage the list at all, every row is. -->
        <span v-if="!canManage || person.role === 'owner'" class="ml-3 text-15 leading-none text-text-3">{{ t(`panel.role.${person.role}`) }}</span>
        <template v-else>
          <Select
            :model-value="person.role"
            :options="roleOptions"
            :width="132"
            class="ml-3"
            :label="t('modal.access.roleOf', { name: person.name })"
            @update:model-value="changeRole(person, $event)"
          />
          <IconButton :label="t('modal.access.revoke', { name: person.name })" :size="36" class="ml-1 text-text-2" @click="revoke(person)">
            <UserMinus :size="18" />
          </IconButton>
        </template>
      </li>
    </ul>

    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.done') }}</Button>
    </template>
  </Modal>
</template>
