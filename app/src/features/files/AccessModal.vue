<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Copy, Users, UserMinus } from 'lucide-vue-next';
import { repository } from '@/data';
import { RBAC_DISABLED, ROLE_FORBIDDEN } from '@/data/repository';
import type { GroupOption, Node, Person } from '@/data/types';
import { errorMessage } from '@/lib/errors';
import { useFilesStore } from '@/stores/files';
import { useFileActions } from '@/features/files/useFileActions';
import Segmented from '@/features/settings/Segmented.vue';
import { Avatar, Button, IconButton, Input, Select } from '@/ui';
import Modal from '@/ui/Modal.vue';

/** Who can see a node, and as what. The link itself lives in the share modal; this is the people side. */
const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const files = useFilesStore();
const actions = useFileActions();

/**
 * Which levels may be handed out. `owner` is on the list for somebody who may manage access — filex's ACL has it,
 * and handing a folder over is a thing people do — but it is never offered to a reader.
 */
const MANAGEABLE = ['owner', 'editor', 'viewer'] as const;
const GRANTABLE = ['editor', 'viewer'] as const;

/** How long the group box waits after the last keystroke before it asks the server. */
const GROUP_SEARCH_DEBOUNCE_MS = 250;

const people = ref<Person[]>([]);
/** A viewer may see who else has access; only an owner may change it, so for everyone else this is a list. */
const canManage = ref(false);
/** Which kind of principal the invite row is naming. */
const principal = ref<'user' | 'group'>('user');
const email = ref('');
const groupQuery = ref('');
const groupResults = ref<GroupOption[]>([]);
const group = ref<GroupOption | null>(null);
const role = ref<Person['role']>('viewer');
const input = ref<InstanceType<typeof Input>>();

/** What the server said about the last read or change; every one of them can be refused, and silence was the answer. */
const error = ref<string | null>(null);
/**
 * The public link an invite minted because the address had no account behind it. Nobody was added to the list, so
 * saying nothing would look like an invite that silently did nothing.
 */
const sharedLink = ref<string | null>(null);

const roleOptions = computed(() =>
  (canManage.value ? MANAGEABLE : GRANTABLE).map((value) => ({ value, label: t(`panel.role.${value}`) })),
);
const principalOptions = computed(() => [
  { value: 'user' as const, label: t('modal.access.principalUser') },
  { value: 'group' as const, label: t('modal.access.principalGroup') },
]);
/** An address, roughly: enough to catch a typo, not enough to argue about the RFC. */
const valid = computed(() => (principal.value === 'group' ? !!group.value : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())));

async function load() {
  let access: { people: Person[]; canManage: boolean };
  try {
    access = await repository.listPeople(props.node.id);
  } catch (e) {
    error.value = readable(e);
    return;
  }
  people.value = access.people;
  canManage.value = access.canManage;
}

/**
 * The listing row and the details panel show the node's shared state, and a grant changes it.
 *
 * Only a change pays for it: `load` used to re-read the whole listing itself, so merely OPENING the modal cost a
 * full folder read plus — through `focusNode` — another people-and-location round trip for the focused node, for
 * data nothing had touched.
 */
async function reload() {
  await load();
  await files.refresh();
}

onMounted(load);

/** The three refusals this panel has words of its own for; anything else is the server's own sentence. */
function readable(e: unknown): string {
  const message = errorMessage(e);
  if (message === ROLE_FORBIDDEN) return t('modal.access.roleForbidden');
  if (message === RBAC_DISABLED) return t('modal.access.rbacOff');
  return message;
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Which search the dropdown belongs to. Two answers can be in flight — the debounce only spaces the questions out,
 * it does not cancel the one already asked — and they can come back in either order, so `des` landing after
 * `design` used to repopulate the list with the wrong matches. A pick bumps it too: an answer arriving after the
 * click would otherwise reopen the list over a selection already made.
 */
let searchToken = 0;
/**
 * The group box asks the server, a beat after the typing stops. Debounced rather than per keystroke: the picker is
 * a type-ahead over a directory that can be large, and every letter of a name is not a question worth asking.
 */
watch(groupQuery, (text) => {
  // Choosing a match fills the box with that group's name, which is a change like any other to this watcher —
  // and clearing the choice there would empty the selection the click had just made.
  if (text === group.value?.name) return;
  group.value = null;
  clearTimeout(searchTimer);
  const token = ++searchToken;
  if (!text.trim()) {
    groupResults.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const found = await repository.searchGroups(text.trim());
      if (token === searchToken) groupResults.value = found;
    } catch (e) {
      if (token === searchToken) error.value = readable(e);
    }
  }, GROUP_SEARCH_DEBOUNCE_MS);
});

onUnmounted(() => clearTimeout(searchTimer));

function pickGroup(option: GroupOption) {
  // The choice outranks anything still in flight: the watcher below steps aside for the name it writes into the
  // box, so the token has to be retired here or a late answer would reopen the list over the pick.
  searchToken++;
  group.value = option;
  groupQuery.value = option.name;
  groupResults.value = [];
}

async function invite() {
  if (!valid.value) return;
  error.value = null;
  sharedLink.value = null;
  const target = principal.value === 'group' ? { groupId: group.value!.id } : { email: email.value.trim() };
  let outcome;
  try {
    // The node's own kind, not a constant: a grant on a file that claims to be on a folder is a grant on nothing.
    outcome = await repository.addPerson(props.node.id, target, role.value, props.node.kind === 'folder');
  } catch (e) {
    // An address nobody here knows, or an account that may not hand out access: the box keeps what was typed so it
    // can be corrected rather than retyped.
    error.value = readable(e);
    return;
  }
  if (outcome.mode === 'shared') {
    // Nobody was added — there is no account to add. The link is the whole result, so it is shown rather than the
    // list being re-read for a row that will not be there.
    sharedLink.value = outcome.url ?? null;
    return;
  }
  email.value = '';
  groupQuery.value = '';
  group.value = null;
  await reload();
}

async function changeRole(person: Person, next: string) {
  error.value = null;
  try {
    await repository.setPersonRole(props.node.id, person.id, next as Person['role']);
  } catch (e) {
    error.value = readable(e);
    // A refused change must not leave the row showing the role the server did not give — but nothing outside this
    // modal changed, so the listing is not re-read.
    await load();
    return;
  }
  await reload();
}

async function revoke(person: Person) {
  error.value = null;
  try {
    await repository.removePerson(props.node.id, person.id);
  } catch (e) {
    error.value = readable(e);
    return;
  }
  await reload();
}
</script>

<template>
  <Modal :title="t('modal.access.title')" :close-label="t('modal.close')" :width="560" :initial-focus="input?.el" @close="emit('close')">
    <p class="text-11.5 leading-tight text-text-3">{{ t('modal.access.hint', { name: node.name }) }}</p>

    <template v-if="canManage">
      <!-- A grant goes to a person or to a group; the toggle says which the box below is naming. -->
      <Segmented v-model="principal" :options="principalOptions" :label="t('modal.access.principal')" class="mt-4 w-[200px]" />

      <form class="mt-3 flex gap-3" @submit.prevent="invite">
        <div class="relative flex-1">
          <Input
            v-if="principal === 'user'"
            ref="input"
            v-model="email"
            :height="44"
            :placeholder="t('modal.access.emailPlaceholder')"
            :label="t('modal.access.email')"
            @enter="invite"
          />
          <template v-else>
            <Input v-model="groupQuery" :height="44" :placeholder="t('modal.access.groupPlaceholder')" :label="t('modal.access.group')" />
            <!-- Matches, under the box. Choosing one fills the box with its name and is what makes Invite live. -->
            <ul
              v-if="groupResults.length"
              class="absolute left-0 right-0 top-[48px] z-10 max-h-[220px] overflow-y-auto rounded-md border border-border bg-bg py-1 shadow-lg"
              :aria-label="t('modal.access.groupResults')"
            >
              <li v-for="option in groupResults" :key="option.id">
                <button type="button" class="flex w-full items-center px-3 py-2 text-left hover:bg-hover-row" @click="pickGroup(option)">
                  <Users :size="18" class="shrink-0 text-text-2" />
                  <span class="ml-2.5 min-w-0 flex-1 truncate-safe text-13 leading-none">{{ option.name }}</span>
                  <span class="ml-3 shrink-0 text-11 leading-none text-text-3">{{ t('modal.access.members', { count: option.memberCount }, option.memberCount) }}</span>
                </button>
              </li>
            </ul>
          </template>
        </div>
        <Select v-model="role" :options="roleOptions" :width="132" :label="t('modal.access.role')" class="!h-11" />
        <Button type="submit" :disabled="!valid" class="!h-11 disabled:opacity-50">{{ t('modal.access.invite') }}</Button>
      </form>
    </template>

    <!-- No account behind that address, so filex minted a public link instead. It is a different thing from a
         grant, and the only place the link is ever shown. -->
    <div v-if="sharedLink" class="mt-4 rounded-md border border-border bg-bg-muted p-3" role="status">
      <p class="text-11.5 leading-tight text-text-2">{{ t('modal.access.sharedInstead') }}</p>
      <div class="mt-2 flex items-center">
        <p class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ sharedLink }}</p>
        <IconButton :label="t('panel.copy')" :size="36" class="ml-2 text-text-2" @click="actions.copyLink(sharedLink)">
          <Copy :size="18" />
        </IconButton>
      </div>
    </div>

    <ul class="mt-5 divide-y divide-border-soft" :aria-label="t('modal.access.people')">
      <li v-for="person in people" :key="person.id" class="flex h-[58px] items-center">
        <!-- A group is not a face: it gets the group mark and its size instead of an initial and an address. -->
        <span v-if="person.principal === 'group'" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-strong">
          <Users :size="18" />
        </span>
        <Avatar v-else :initial="person.initial" />
        <div class="ml-3 min-w-0 flex-1">
          <p class="truncate-safe text-13 leading-none">{{ person.id === files.user?.id ? t('panel.you') : person.name }}</p>
          <p class="mt-1.5 truncate-safe text-11 leading-none text-text-3">
            {{ person.principal === 'group' ? t('modal.access.members', { count: person.memberCount ?? 0 }, person.memberCount ?? 0) : person.id }}
          </p>
        </div>
        <!-- The owner's role is not a permission anyone can hand out, so that row is read-only — and for a caller
             who may not manage the list at all, every row is. -->
        <span v-if="!canManage || person.role === 'owner'" class="ml-3 text-13 leading-none text-text-3">{{ t(`panel.role.${person.role}`) }}</span>
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
    <p v-if="error" class="mt-3 text-11 leading-none text-danger" role="alert">{{ error }}</p>

    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.done') }}</Button>
    </template>
  </Modal>
</template>
