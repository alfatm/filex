<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Copy, Link, Star, X } from 'lucide-vue-next';
import { repository } from '@/data';
import type { ActivityEvent, Node, Person, User } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { reportUnhandled } from '@/lib/errors';
import { useOperationsStore } from '@/features/files/operationsStore';
import { useFileActions } from '@/features/files/useFileActions';
import { sharedDriveOf } from '@/features/files/owner';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { useViewStore } from '@/stores/view';
import { Avatar, Button, IconButton, SidePanel, Tabs } from '@/ui';
import FileTypeTile from './FileTypeTile.vue';
import FolderIcon from './FolderIcon.vue';

const props = defineProps<{ node: Node; path: Node[]; people: Person[]; user: User | null }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const view = useViewStore();
const actions = useFileActions();
const capabilities = useCapabilitiesStore();
const toast = useToastStore();

/** Minting and revoking a public link is one permission; without it the panel still SHOWS the link it has. */
const canShare = computed(() => capabilities.allows('files.share'));
const operations = useOperationsStore();

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

/** The same rule the listing's Owner column applies, so the panel and the row can never disagree about who owns it. */
const ownerLabel = computed(
  () => sharedDriveOf(props.node, files.storages) ?? personName(props.node.ownerId, props.node.ownerName ?? props.node.ownerId),
);

const rows = computed(() => [
  { key: 'type', value: typeLabel.value },
  { key: 'location', value: location.value },
  { key: 'size', value: props.node.kind === 'folder' ? '—' : formatSize(props.node.size) },
  { key: 'modified', value: formatDateTime(props.node.modifiedAt) },
  // A listing row carries no creation date on every backend; the row is dropped rather than shown empty.
  ...(props.node.createdAt ? [{ key: 'created', value: formatDateTime(props.node.createdAt) }] : []),
  { key: 'owner', value: ownerLabel.value },
]);

// The feed is per node and reloads whenever the node or the store's revision changes, so an action the user just
// took is at the top of the list by the time they switch to the tab.
const activity = ref<ActivityEvent[]>([]);
watch(
  [() => props.node.id, () => files.revision, tab] as const,
  async ([id, , current]) => {
    if (current !== 'activity') return;
    let list: ActivityEvent[];
    try {
      list = await repository.listActivity(id);
    } catch (e) {
      // Two things the rejection used to cost. The feed kept the PREVIOUS node's events, so they were shown under
      // this node's name — the same trap the store's focus watcher already guards against. And nobody was told:
      // the only reason a toast appeared at all was Vue routing the rejected watcher callback to the sink by
      // itself, which a catch here would have swallowed. So the sink is called on purpose.
      if (props.node.id === id) activity.value = [];
      reportUnhandled(e);
      return;
    }
    if (props.node.id === id) activity.value = list;
  },
  { immediate: true },
);

// The link is not part of a listing row: a viewer may see that a node is shared, but the URL itself is editor+
// business, so it is fetched per node. `files.revision` is in the key so creating or removing one refreshes it.
const shareUrl = ref<string | null>(null);
/**
 * The read itself failed, so neither "it has a link" nor "it has none" is known.
 *
 * Saying "Not shared" here would be a guess, and the Create-link button beside it would mint a SECOND link for a
 * node that already had one; the section says it could not tell instead, and offers nothing.
 */
const shareUnknown = ref(false);
watch(
  [() => props.node.id, () => files.revision] as const,
  async ([id]) => {
    let url: string | null;
    try {
      url = await repository.shareLink(id);
    } catch {
      if (props.node.id === id) {
        shareUrl.value = null;
        shareUnknown.value = true;
      }
      return;
    }
    if (props.node.id !== id) return;
    shareUrl.value = url;
    shareUnknown.value = false;
  },
  { immediate: true },
);

// Minting and revoking a link are mutations like any other, so they go through the operations tray: called straight
// on the store the rejection reached nobody and the panel simply went on showing the old state.
function createLink() {
  void operations.run(t('op.sharing'), async () => {
    await files.createShareLink(props.node.id);
  });
}

function removeLink() {
  void operations.run(t('op.unsharing'), () => files.removeShareLink(props.node.id));
}

async function copyName() {
  await navigator.clipboard.writeText(props.node.name);
  toast.push(t('toast.nameCopied'));
}

/**
 * "You renamed it from “notes.md”" — the actor, the verb, and at most one variable part.
 *
 * Two sentences per event rather than one with a name in a slot: Russian and Turkish agree the verb with who acted,
 * so "Вы создал" and "Siz oluşturdu" are what a single form produces for oneself. The third-person Russian carries
 * "(а)" because filex records no gender for anybody and inventing one is worse than admitting both.
 */
function sentence(event: ActivityEvent): string {
  const detail = event.detail ?? '';
  if (event.actorId === props.user?.id) return t(`activity.self.${event.kind}`, { detail });
  return t(`activity.${event.kind}`, { actor: event.actorName, detail });
}
</script>

<template>
  <!-- A properties inspector (spec §3/§12): section title, content, divider — no nested cards, and the same
       gutters on both sides so the label column starts where the header icon does. -->
  <SidePanel
    :width="view.detailsWidth"
    :resize-label="t('panel.resize')"
    :aria-label="t('files.details')"
    @resize="view.setDetailsWidth"
  >
    <div class="flex items-start">
      <FolderIcon v-if="node.kind === 'folder'" :width="34" :height="28" :shared="node.shared" />
      <FileTypeTile v-else :type="node.fileType ?? 'other'" :size="28" />
      <div class="ml-2.5 min-w-0 flex-1">
        <!-- The panel is where the full name lives: it wraps instead of truncating, and the button beside it puts
             the same string on the clipboard, since a listing row only ever shows the head of a long name. -->
        <h2 class="flex items-start text-14 font-semibold leading-tight">
          <span class="min-w-0 break-words">{{ node.name }}</span>
          <Star v-if="node.starred" :size="14" class="ml-1.5 mt-0.5 shrink-0 text-folder" fill="currentColor" :aria-label="t('panel.starred')" />
        </h2>
        <p class="mt-1 text-11 leading-none text-text-3">{{ meta }}</p>
      </div>
      <IconButton :label="t('panel.copyName')" :size="28" class="-mt-1 shrink-0 text-text-3" @click="copyName()">
        <Copy :size="16" />
      </IconButton>
      <IconButton :label="t('panel.close')" :size="28" class="-mr-1.5 -mt-1 shrink-0" @click="emit('close')">
        <X :size="16" />
      </IconButton>
    </div>

    <Tabs v-model="tab" :tabs="tabs" class="mt-4" />

    <template v-if="tab === 'details'">
      <!-- Images get their tile picture (never the original) as a preview that opens the full-size modal; folders and other files keep the reference geometry. -->
      <button
        v-if="node.fileType === 'image' && node.thumbUrl"
        type="button"
        :aria-label="t('menu.preview')"
        class="mt-3 block h-[140px] w-full overflow-hidden rounded-lg border border-border bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        @click="actions.preview(node)"
      >
        <img :src="node.thumbUrl" :alt="node.name" loading="lazy" decoding="async" class="h-full w-full object-cover" />
      </button>
      <h3 class="text-12 font-semibold leading-none" :class="node.fileType === 'image' && node.thumbUrl ? 'mt-4' : 'mt-5'">{{ t('panel.general') }}</h3>
      <dl class="mt-2">
        <div v-for="row in rows" :key="row.key" class="flex h-[25px] items-center text-11.5 leading-none">
          <dt class="w-[76px] shrink-0 text-text-3">{{ t(`panel.${row.key}`) }}</dt>
          <dd :title="row.value" class="truncate text-text">{{ row.value }}</dd>
        </div>
      </dl>

      <div class="my-3 h-px bg-border" />

      <h3 class="text-12 font-semibold leading-none">{{ t('panel.peopleWithAccess') }}</h3>
      <ul class="mt-2 space-y-2">
        <li v-for="person in people" :key="person.id" class="flex items-center">
          <Avatar :initial="person.initial" :size="24" />
          <div class="ml-2">
            <p class="text-11.5 leading-none">{{ personName(person.id, person.name) }}</p>
            <p class="mt-1 text-11 leading-none text-text-3">{{ t(`panel.role.${person.role}`) }}</p>
          </div>
        </li>
      </ul>

      <div class="my-3 h-px bg-border" />

      <h3 class="text-12 font-semibold leading-none">{{ t('panel.sharedLink') }}</h3>
      <div class="mt-2 flex items-center">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-2">
          <Link :size="14" />
        </span>
        <p v-if="shareUnknown" class="ml-2 flex-1 text-11.5 leading-none text-text-3" role="alert">{{ t('panel.shareUnknown') }}</p>
        <template v-else-if="shareUrl">
          <p class="ml-2 min-w-0 flex-1 truncate-safe text-11.5 leading-none">{{ shareUrl }}</p>
          <IconButton :label="t('panel.copy')" :size="28" @click="actions.copyLink(shareUrl)"><Copy :size="16" /></IconButton>
          <Button v-if="canShare" variant="ghost" class="!h-control-sm px-2" @click="removeLink()">{{ t('panel.remove') }}</Button>
        </template>
        <template v-else>
          <p class="ml-2 flex-1 text-11.5 leading-none text-text-3">{{ t('panel.notShared') }}</p>
          <Button v-if="canShare" variant="outline" @click="createLink()">{{ t('panel.createLink') }}</Button>
          <span v-else class="text-11 leading-none text-text-3">{{ t('common.notAllowed') }}</span>
        </template>
      </div>
    </template>

    <ul v-else class="mt-4 space-y-3" :aria-label="t('panel.tabActivity')">
      <li v-for="event in activity" :key="event.id" class="flex items-start">
        <Avatar :initial="event.actorId === user?.id ? (user?.initial ?? '') : event.actorName.charAt(0)" :size="24" />
        <div class="ml-2 min-w-0">
          <p class="text-11.5 leading-snug">{{ sentence(event) }}</p>
          <p class="mt-1 text-11 leading-none text-text-3">{{ formatDateTime(event.at) }}</p>
        </div>
      </li>
    </ul>
  </SidePanel>
</template>
