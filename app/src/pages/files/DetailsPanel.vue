<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { Copy, Link, Star, Tag, X } from 'lucide-vue-next';
import { repository } from '@/data';
import { sizeBandOf, typeGroupOf } from '@/data/listingFilter';
import type { ActivityEvent, ListingFilter, Node, Person, User } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { reportUnhandled } from '@/lib/errors';
import { filesRoute } from '@/lib/path';
import { useOperationsStore } from '@/features/files/operationsStore';
import { toFilterQuery } from '@/features/files/filterQuery';
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
const router = useRouter();
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

/**
 * The owner holds their access by owning the node, not through a grant, so the permissions answer never lists them
 * — which left "People with access" empty over a person's own files. They lead the list; a grant on the same id
 * (an owner who also has an explicit one) is dropped so the row is not printed twice.
 */
const access = computed<Person[]>(() => {
  const name = props.node.ownerName ?? props.node.ownerId;
  const owner: Person = {
    id: props.node.ownerId,
    name,
    initial: (props.node.ownerId === props.user?.id ? props.user.initial : name.trim()[0]) || '?',
    role: 'owner',
    principal: 'user',
  };
  return [owner, ...props.people.filter((person) => person.id !== owner.id)];
});

/** The same rule the listing's Owner column applies, so the panel and the row can never disagree about who owns it. */
const ownerLabel = computed(
  () => sharedDriveOf(props.node, files.storages) ?? personName(props.node.ownerId, props.node.ownerName ?? props.node.ownerId),
);

/**
 * Narrows the listing by one of the properties on show — "the other files like this one".
 *
 * It MERGES into the filter already applied rather than replacing it, so two clicks are two conditions; the chips
 * above the listing show what is set, including the two (tags, the date window) that have no menu of their own.
 *
 * Home has no listing to narrow — it is a page of sections, not a folder — so a filter set from there is applied to
 * the folder the node actually lives in, and the panel travels with it.
 */
async function apply(patch: Partial<ListingFilter>) {
  const next = { ...files.filter, ...patch };
  // The filter lives in the listing's address (`useFilterQuery`), so travelling to one carries it in the URL
  // rather than in the store: the page it lands on reads its chips off the query like any other arrival.
  if (!files.listing && props.path.length) {
    const landing = filesRoute(props.path[0].name, props.path.slice(1).map((n) => n.name));
    await router.push({ ...landing, query: toFilterQuery(next) });
    return;
  }
  await files.setFilter(next);
}

/**
 * The properties, and what narrowing by each of them means. A row with no `filter` is one nothing can be asked
 * about: a type outside the chip's groups, a folder's size, a node whose backend dates nothing.
 *
 * Both date rows filter by a WINDOW around what they show — a day either side — rather than by that calendar day:
 * the question is "what else was written around then", and a file at 23:50 and one at 00:10 are twenty minutes
 * apart. Setting it clears the Modified chip's preset, which is a window over the same column.
 */
const rows = computed<{ key: string; value: string; filter?: () => void }[]>(() => {
  const node = props.node;
  const group = node.kind === 'file' ? typeGroupOf(node.fileType) : null;
  return [
    { key: 'type', value: typeLabel.value, ...(group ? { filter: () => void apply({ fileType: group }) } : {}) },
    // The location is not a filter but an address: clicking it opens the folder the node sits in.
    { key: 'location', value: location.value, ...(props.path.length ? { filter: () => void openLocation() } : {}) },
    // The MIME type as the server recorded it, and "the other files of exactly this type" when clicked. Shown only
    // where there is one: a row the server typed nothing for is the Created case again, and an empty line would
    // read as a claim about the file rather than about what is known of it.
    ...(node.kind === 'file' && node.mime
      ? [{ key: 'mime', value: node.mime, filter: () => void apply({ mime: node.mime!.toLowerCase() }) }]
      : []),
    {
      key: 'size',
      value: node.kind === 'folder' ? '—' : formatSize(node.size),
      ...(node.kind === 'file' ? { filter: () => void apply({ size: sizeBandOf(node.size) }) } : {}),
    },
    {
      key: 'modified',
      value: formatDateTime(node.modifiedAt),
      ...(node.modifiedAt ? { filter: () => void apply({ around: { field: 'modified', at: node.modifiedAt!, span: 'day' }, modified: 'any' }) } : {}),
    },
    // A listing row carries no creation date on every backend; the row is dropped rather than shown empty.
    ...(node.createdAt
      ? [
          {
            key: 'created',
            value: formatDateTime(node.createdAt),
            filter: () => void apply({ around: { field: 'created', at: node.createdAt!, span: 'day' }, modified: 'any' }),
          },
        ]
      : []),
    { key: 'owner', value: ownerLabel.value, filter: () => void apply({ personId: node.ownerId }) },
  ];
});

function openLocation() {
  return router.push(filesRoute(props.path[0].name, props.path.slice(1).map((n) => n.name)));
}

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

/**
 * The node's tags. No listing row carries them — the server answers them per node — so the panel reads them the
 * way the tag modal does, and re-reads on `files.revision` so a tag added from that modal shows up here at once.
 *
 * `tagsUnknown` is the same distinction the share link makes: a read that FAILED is not a node with no tags, and
 * saying "None" would be a claim about the file rather than about the request.
 */
const tags = ref<string[]>([]);
const tagsUnknown = ref(false);
watch(
  [() => props.node.id, () => files.revision] as const,
  async ([id]) => {
    if (!capabilities.can.tags) return;
    let list: string[];
    try {
      list = await repository.listTags(id);
    } catch {
      if (props.node.id === id) {
        tags.value = [];
        tagsUnknown.value = true;
      }
      return;
    }
    if (props.node.id !== id) return;
    tags.value = list;
    tagsUnknown.value = false;
  },
  { immediate: true },
);

/** A tag already in the filter is not added twice — clicking it again would narrow to nothing new. */
function filterByTag(tag: string) {
  if (files.filter.tags.includes(tag)) return;
  void apply({ tags: [...files.filter.tags, tag] });
}

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
          <!-- A property that can narrow the listing is a button; one that cannot stays text, rather than looking
               clickable and doing nothing. -->
          <dd class="min-w-0 truncate-safe text-text">
            <button
              v-if="row.filter"
              type="button"
              :title="t(row.key === 'location' ? 'panel.openLocation' : 'panel.filterBy', { value: row.value })"
              class="max-w-full truncate-safe rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
              @click="row.filter()"
            >
              {{ row.value }}
            </button>
            <span v-else :title="row.value">{{ row.value }}</span>
          </dd>
        </div>
      </dl>

      <template v-if="capabilities.can.tags">
        <div class="my-3 h-px bg-border" />

        <h3 class="text-12 font-semibold leading-none">{{ t('panel.tags') }}</h3>
        <p v-if="tagsUnknown" class="mt-2 text-11.5 leading-none text-text-3" role="alert">{{ t('panel.tagsUnknown') }}</p>
        <!-- Each tag narrows the listing to what else carries it; the chip for it then appears above the rows. -->
        <ul v-else-if="tags.length" class="mt-2 flex flex-wrap gap-2">
          <li v-for="tag in tags" :key="tag">
            <button
              type="button"
              :title="t('panel.filterBy', { value: tag })"
              class="flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-2 pr-3 text-11.5 leading-none text-primary hover:bg-primary-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
              @click="filterByTag(tag)"
            >
              <Tag :size="12" />
              <span>{{ tag }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="mt-2 text-11.5 leading-none text-text-3">{{ t('panel.noTags') }}</p>
      </template>

      <div class="my-3 h-px bg-border" />

      <h3 class="text-12 font-semibold leading-none">{{ t('panel.peopleWithAccess') }}</h3>
      <ul class="mt-2 space-y-2">
        <li v-for="person in access" :key="person.id" class="flex items-center">
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
