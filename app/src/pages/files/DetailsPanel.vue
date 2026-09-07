<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Copy, Link, Star, X } from 'lucide-vue-next';
import { repository } from '@/data';
import type { ActivityEvent, Node, Person, User } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useFileActions } from '@/features/files/useFileActions';
import { useFilesStore } from '@/stores/files';
import { Avatar, Button, IconButton, SidePanel, Tabs } from '@/ui';
import FileTypeTile from './FileTypeTile.vue';
import FolderIcon from './FolderIcon.vue';

const props = defineProps<{ node: Node; path: Node[]; people: Person[]; user: User | null }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const actions = useFileActions();

type PanelTab = 'details' | 'activity';
const tab = ref<PanelTab>('details');
const tabs = computed(() => [
  { id: 'details' as const, label: t('panel.tabDetails') },
  { id: 'activity' as const, label: t('panel.tabActivity') },
]);

const typeLabel = computed(() =>
  props.node.kind === 'folder' ? t('type.folder') : t(`type.${props.node.fileType ?? 'other'}`),
);
const meta = computed(() =>
  props.node.kind === 'folder'
    ? (props.node.itemCount === undefined ? t('type.folder') : t('panel.folderMeta', props.node.itemCount))
    : t('panel.fileMeta', { type: typeLabel.value, size: formatSize(props.node.size) }),
);
const location = computed(() => '/' + props.path.map((n) => n.name).join('/'));

function personName(id: string, name: string): string {
  return id === props.user?.id ? t('panel.you') : name;
}

const rows = computed(() => [
  { key: 'type', value: typeLabel.value },
  { key: 'location', value: location.value },
  { key: 'size', value: props.node.kind === 'folder' ? '—' : formatSize(props.node.size) },
  { key: 'modified', value: formatDateTime(props.node.modifiedAt) },
  // A listing row carries no creation date on every backend; the row is dropped rather than shown empty.
  ...(props.node.createdAt ? [{ key: 'created', value: formatDateTime(props.node.createdAt) }] : []),
  { key: 'owner', value: personName(props.node.ownerId, props.node.ownerName ?? props.node.ownerId) },
]);

// The feed is per node and reloads whenever the node or the store's revision changes, so an action the user just
// took is at the top of the list by the time they switch to the tab.
const activity = ref<ActivityEvent[]>([]);
watch(
  [() => props.node.id, () => files.revision, tab] as const,
  async ([id, , current]) => {
    if (current !== 'activity') return;
    const list = await repository.listActivity(id);
    if (props.node.id === id) activity.value = list;
  },
  { immediate: true },
);

/** "You renamed it from “notes.md”" — the actor, the verb, and at most one variable part. */
function sentence(event: ActivityEvent): string {
  const actor = event.actorId === props.user?.id ? t('panel.you') : event.actorName;
  return t(`activity.${event.kind}`, { actor, detail: event.detail ?? '' });
}
</script>

<template>
  <!-- Spec §3 draws a 320 panel at x 1322 with white to its right; here it is flush right (364) so the content column
       still ends at x 1297, and the extra left padding puts the labels at x 1342 / values at x 1440. -->
  <SidePanel :width="364" class="!pl-[33px]" :aria-label="t('files.details')">
    <div class="flex items-start pt-2">
      <FolderIcon v-if="node.kind === 'folder'" :width="52" :height="44" :shared="node.shared" />
      <FileTypeTile v-else :type="node.fileType ?? 'other'" :size="44" />
      <div class="ml-4 min-w-0 flex-1">
        <h2 class="flex items-center text-20 font-semibold leading-tight">
          <span class="truncate">{{ node.name }}</span>
          <Star v-if="node.starred" :size="18" class="ml-2 shrink-0 text-folder" fill="currentColor" :aria-label="t('panel.starred')" />
        </h2>
        <p class="mt-1 text-14 leading-none text-text-3">{{ meta }}</p>
      </div>
      <IconButton :label="t('panel.close')" :size="36" class="-mr-2 -mt-2" @click="emit('close')">
        <X :size="22" />
      </IconButton>
    </div>

    <Tabs v-model="tab" :tabs="tabs" class="mt-[46px]" />

    <template v-if="tab === 'details'">
      <!-- Images get a preview that opens the full-size modal; folders and other files keep the reference geometry. -->
      <button
        v-if="node.fileType === 'image' && node.assetUrl"
        type="button"
        :aria-label="t('menu.preview')"
        class="mt-6 block h-[180px] w-full overflow-hidden rounded-lg border border-border bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        @click="actions.preview(node)"
      >
        <img :src="node.assetUrl" :alt="node.name" loading="lazy" decoding="async" class="h-full w-full object-cover" />
      </button>
      <h3 class="text-16 font-semibold leading-6" :class="node.fileType === 'image' && node.assetUrl ? 'mt-6' : 'mt-8'">{{ t('panel.general') }}</h3>
      <dl class="mt-2">
        <div v-for="row in rows" :key="row.key" class="flex h-[31px] items-center text-15 leading-none">
          <dt class="w-[98px] shrink-0 text-text-3">{{ t(`panel.${row.key}`) }}</dt>
          <dd class="truncate text-text">{{ row.value }}</dd>
        </div>
      </dl>

      <div class="my-2 h-px bg-border" />

      <h3 class="mt-4 text-16 font-semibold leading-6">{{ t('panel.peopleWithAccess') }}</h3>
      <ul class="mt-3 space-y-3">
        <li v-for="person in people" :key="person.id" class="flex items-center">
          <Avatar :initial="person.initial" />
          <div class="ml-3">
            <p class="text-15 leading-none">{{ personName(person.id, person.name) }}</p>
            <p class="mt-1 text-13 leading-none text-text-3">{{ t(`panel.role.${person.role}`) }}</p>
          </div>
        </li>
      </ul>

      <div class="my-5 h-px bg-border" />

      <h3 class="text-16 font-semibold leading-6">{{ t('panel.sharedLink') }}</h3>
      <div class="mt-3 flex items-center">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-2">
          <Link :size="16" />
        </span>
        <template v-if="node.shareUrl">
          <p class="ml-3 min-w-0 flex-1 truncate-safe text-15 leading-none">{{ node.shareUrl }}</p>
          <IconButton :label="t('panel.copy')" :size="36" @click="actions.copyLink(node.shareUrl)"><Copy :size="18" /></IconButton>
          <Button variant="ghost" class="h-9 px-3" @click="files.removeShareLink(node.id)">{{ t('panel.remove') }}</Button>
        </template>
        <template v-else>
          <p class="ml-3 flex-1 text-15 leading-none text-text-3">{{ t('panel.notShared') }}</p>
          <Button variant="outline" @click="files.createShareLink(node.id)">{{ t('panel.createLink') }}</Button>
        </template>
      </div>
    </template>

    <ul v-else class="mt-6 space-y-4" :aria-label="t('panel.tabActivity')">
      <li v-for="event in activity" :key="event.id" class="flex items-start">
        <Avatar :initial="event.actorId === user?.id ? (user?.initial ?? '') : event.actorName.charAt(0)" />
        <div class="ml-3 min-w-0">
          <p class="text-15 leading-snug">{{ sentence(event) }}</p>
          <p class="mt-1 text-13 leading-none text-text-3">{{ formatDateTime(event.at) }}</p>
        </div>
      </li>
    </ul>
  </SidePanel>
</template>
