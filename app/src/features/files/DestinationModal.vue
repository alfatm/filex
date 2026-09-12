<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, HardDrive, Loader2, Search } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { subjectMessage } from '@/i18n/subject';
import { isInside, splitPath } from '@/lib/address';
import { errorMessage } from '@/lib/errors';
import FolderIcon from '@/pages/files/FolderIcon.vue';
import { useFilesStore } from '@/stores/files';
import { Button, Input, Select } from '@/ui';
import Modal from '@/ui/Modal.vue';

/** One picker, two verbs: `move` takes the nodes there, `copy` leaves them and puts a duplicate there. */
const props = defineProps<{ nodes: Node[]; mode: 'move' | 'copy' }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();

interface Row {
  node: Node;
  depth: number;
  disabled: boolean;
  /** Ancestor chain shown beside the name while the list is filtered (the tree indentation is gone then). */
  location?: string;
  /** Only a row in the tree can be opened; a filter result is shown flat and has nothing to open. */
  expandable?: boolean;
  open?: boolean;
  loading?: boolean;
}

const copying = computed(() => props.mode === 'copy');
/**
 * The drive(s) the nodes live on, read from the nodes themselves.
 *
 * A node's id is its address, so the drive is in it. It used to be taken from the open listing instead, which is
 * only the same thing inside a folder: on Starred, Recent and Shared the listing has no drive of its own and the
 * store falls back to the home one, so a copy of something on another mount greyed out every drive but the wrong.
 */
const sourceDrives = new Set(props.nodes.map((n) => splitPath(n.id).adapter));
const source = [...sourceDrives][0] ?? files.storage?.id ?? '';
const storageId = ref(source);
// A copy across drives spans two adapters, which the server refuses. The other drives stay listed and greyed:
// the answer the UI owes here is "not to there", not "there is nowhere else". A selection spanning two drives has
// no drive it can be copied to at all, and says so the same way.
const storageOptions = computed(() =>
  files.storages.map((s) => ({
    value: s.id,
    label: s.name,
    disabled: copying.value && !(sourceDrives.size === 1 && sourceDrives.has(s.id)),
  })),
);
/**
 * The tree, a level at a time.
 *
 * `children` holds what has been fetched, keyed by folder; a key that is absent has never been asked for. Loading
 * the whole drive up front is one request per folder — fine on a demo tree, a stall on a real one — and most of it
 * is never looked at, because a person opens two or three folders and picks one.
 */
const children = ref(new Map<string, Node[]>());
const open = ref(new Set<string>());
const loading = ref(new Set<string>());
const filter = ref('');
const targetId = ref<string | null>(null);
const INDENT = 22;
/** Every folder this modal has seen, so a selected id can be resolved to a node whichever list produced it. */
const known = ref(new Map<string, Node>());

/** What the server said about the last folder read or filter search; null while nothing has gone wrong. */
const error = ref<string | null>(null);

function remember(nodes: Node[]) {
  for (const node of nodes) known.value.set(node.id, node);
}

async function load(id: string) {
  if (children.value.has(id) || loading.value.has(id)) return;
  loading.value = new Set(loading.value).add(id);
  error.value = null;
  try {
    const found = await repository.listSubfolders(id);
    remember(found);
    children.value = new Map(children.value).set(id, found);
  } catch (e) {
    // Nothing is cached for the folder, so opening it again is a fresh attempt rather than a permanent empty.
    error.value = errorMessage(e);
  } finally {
    const next = new Set(loading.value);
    next.delete(id);
    loading.value = next;
  }
}

async function toggle(id: string) {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id);
  else {
    next.add(id);
    void load(id);
  }
  open.value = next;
}

const moving = computed(() => new Set(props.nodes.map((n) => n.id)));
const parents = computed(() => new Set(props.nodes.map((n) => n.parentId)));
/** The folders on the move: nothing inside one of them can be where it goes. */
const movingFolders = computed(() => props.nodes.filter((n) => n.kind === 'folder').map((n) => n.id));

/** A folder that cannot take these nodes: one of them, or somewhere inside one of them. */
function insideMoved(id: string): boolean {
  return moving.value.has(id) || movingFolders.value.some((folder) => isInside(id, folder));
}

// Depth-first over what is open; a folder and everything inside it cannot be its own destination. The folder the
// nodes already sit in is a target for a copy — that duplicates them where they are — but not for a move, which has
// nothing to do there.
const tree = computed<Row[]>(() => {
  const root = known.value.get(rootId.value);
  if (!root) return [];
  const out: Row[] = [];
  const walk = (node: Node, depth: number, blocked: boolean) => {
    const inside = blocked || moving.value.has(node.id);
    const kids = children.value.get(node.id);
    out.push({
      node,
      depth,
      disabled: inside || (!copying.value && parents.value.has(node.id)),
      // A folder nobody has opened yet is offered as openable: whether it holds anything is exactly what opening it
      // answers, and hiding the control until then would make an unopened folder look like an empty one.
      expandable: kids === undefined || kids.length > 0,
      open: open.value.has(node.id),
      loading: loading.value.has(node.id),
    });
    if (!open.value.has(node.id)) return;
    for (const child of kids ?? []) walk(child, depth + 1, inside);
  };
  walk(root, 0, false);
  return out;
});

/**
 * Where a filter hit lives, without asking for anything.
 *
 * Names first, from the folders this modal has already seen — walking up `parentId` through them. A hit deeper than
 * anything opened breaks that chain, and then the ADDRESS answers instead: filex's path segments are the names, so
 * it says the same thing. (The mock slugifies its ids, which is why the names are tried first.)
 */
function locationOf(node: Node): string {
  const names: string[] = [];
  for (let id = node.parentId; id !== null; ) {
    const parent = known.value.get(id);
    if (!parent) {
      const parts = splitPath(node.id).rel.split('/').filter(Boolean);
      return `/${parts.slice(0, -1).join('/')}`;
    }
    if (parent.parentId === null) break; // the drive root; its name is the drive's, not a folder in the path
    names.unshift(parent.name);
    id = parent.parentId;
  }
  return `/${names.join('/')}`;
}

const hits = ref<Node[]>([]);
const searching = ref(false);

// A filter replaces the tree with the matching folders, each with its location. The question goes to the SERVER:
// the tree holds only what somebody opened, so a filter over it would search two or three folders and call that
// the drive.
const rows = computed<Row[]>(() => {
  if (!filter.value.trim()) return tree.value;
  return hits.value.map((node) => ({
    node,
    depth: 0,
    // The tree blocks a folder's whole subtree by walking into it; a flat hit list has no walk, so the ADDRESS
    // answers instead — without this a search found the folder being moved from inside itself and offered it.
    disabled: insideMoved(node.id) || (!copying.value && parents.value.has(node.id)),
    location: locationOf(node),
  }));
});

const target = computed(() => known.value.get(targetId.value ?? '') ?? null);
const rootId = computed(() => files.storages.find((s) => s.id === storageId.value)?.rootId ?? '');

watch(
  storageId,
  async (id) => {
    targetId.value = null;
    filter.value = '';
    children.value = new Map();
    open.value = new Set();
    known.value = new Map();
    if (!id) return;
    const root = files.storages.find((s) => s.id === id);
    if (!root) return;
    remember([{ id: root.rootId, name: root.name, kind: 'folder', parentId: null, size: 0, ownerId: '', shared: false, starred: false }]);
    open.value = new Set([root.rootId]);
    await load(root.rootId);
  },
  { immediate: true },
);

// Debounced, because the filter box asks the server on every keystroke and a half-typed word is not a question
// worth asking. The guard on `text` is what keeps a slow answer from overwriting a newer one.
let filterTimer: ReturnType<typeof setTimeout> | undefined;
watch(filter, (text) => {
  clearTimeout(filterTimer);
  const needle = text.trim();
  if (!needle) {
    hits.value = [];
    searching.value = false;
    error.value = null;
    return;
  }
  searching.value = true;
  error.value = null;
  filterTimer = setTimeout(async () => {
    let found: Node[];
    try {
      found = await repository.searchFolders(storageId.value, needle);
    } catch (e) {
      // A newer keystroke owns the box; its own answer decides. Otherwise: "Searching…" stops — it used to stay up
      // for the rest of the modal's life — and the reason takes its place.
      if (filter.value.trim() !== needle) return;
      hits.value = [];
      error.value = errorMessage(e);
      searching.value = false;
      return;
    }
    if (filter.value.trim() !== needle) return;
    remember(found);
    hits.value = found;
    searching.value = false;
  }, 200);
});

onBeforeUnmount(() => clearTimeout(filterTimer));

async function submit() {
  if (!target.value) return;
  if (copying.value) await files.copyInto(props.nodes, target.value);
  else await files.move(props.nodes, target.value);
  emit('close');
}
</script>

<template>
  <Modal
    :title="subjectMessage(t, copying ? 'modal.destination.copyTitle' : 'modal.destination.moveTitle', nodes)"
    :close-label="t('modal.cancel')"
    @close="emit('close')"
  >
    <div class="flex gap-3">
      <Select v-model="storageId" :options="storageOptions" :icon="HardDrive" :width="200" :label="t('modal.destination.storage')" />
      <Input v-model="filter" type="search" :icon="Search" class="flex-1" :placeholder="t('modal.destination.filter')" :label="t('modal.destination.filter')" />
    </div>
    <p v-if="copying && storageOptions.length > 1" class="mt-2 text-11 text-text-3">{{ t('modal.destination.crossDrive') }}</p>
    <ul role="listbox" :aria-label="t('modal.destination.folder')" class="mt-3 max-h-[320px] overflow-y-auto rounded-md border border-border py-1">
      <!--
        The chevron is a control now, not decoration: the tree is loaded a level at a time, so opening a folder is
        what fetches it. It sits BESIDE the option rather than inside it — a button within a button is not a thing
        a browser or a screen reader can make sense of — and the row carries the selection background so the two
        still read as one line.
      -->
      <li
        v-for="row in rows"
        :key="row.node.id"
        class="flex h-10 items-center"
        :class="targetId === row.node.id ? 'bg-primary-soft' : row.disabled ? '' : 'hover:bg-hover-row'"
      >
        <button
          v-if="row.expandable"
          type="button"
          :aria-label="t(row.open ? 'modal.destination.collapse' : 'modal.destination.expand', { name: row.node.name })"
          :aria-expanded="row.open"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover-row"
          :style="{ marginLeft: `${8 + row.depth * INDENT}px` }"
          @click="toggle(row.node.id)"
        >
          <Loader2 v-if="row.loading" :size="14" class="animate-spin" />
          <ChevronRight :size="14" :class="row.open ? 'rotate-90' : ''" />
        </button>
        <span v-else class="h-6 w-6 shrink-0" :style="{ marginLeft: `${8 + row.depth * INDENT}px` }" />
        <button
          type="button"
          role="option"
          :aria-selected="targetId === row.node.id"
          :disabled="row.disabled"
          class="flex h-10 min-w-0 flex-1 items-center pl-1 pr-3 text-left text-13 leading-none disabled:text-text-3"
          @click="targetId = row.node.id"
        >
          <FolderIcon :width="24" :height="20" :shared="row.node.shared" class="mr-3 shrink-0" />
          <span class="truncate">{{ row.node.name }}</span>
          <span v-if="row.location" class="ml-3 truncate text-11 text-text-3">{{ row.location }}</span>
        </button>
      </li>
      <li v-if="searching" class="px-3 py-6 text-center text-13 text-text-3">{{ t('modal.destination.searching') }}</li>
      <li v-else-if="!rows.length && !error" class="px-3 py-6 text-center text-13 text-text-3">{{ t('modal.destination.noMatch') }}</li>
    </ul>
    <p v-if="error" class="mt-2 text-11 leading-none text-danger" role="alert">{{ error }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!target" class="disabled:opacity-50" @click="submit">{{ t(copying ? 'modal.destination.copyConfirm' : 'modal.destination.moveConfirm') }}</Button>
    </template>
  </Modal>
</template>
