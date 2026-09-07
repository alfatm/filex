import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useSelection } from '@/composables/useSelection';
import { repository } from '@/data';
import type { Node, Person, Storage, UploadInput, User } from '@/data/types';
import { i18n } from '@/i18n';
import { subjectMessage } from '@/i18n/subject';
import { useToastStore } from './toast';
import { useViewStore } from './view';

/** Flat listings that reuse the table, selection and sort of the folder view. */
export type ListingKind = 'recent' | 'starred' | 'shared' | 'trash';
type Listing = { kind: 'folder'; folderId: string } | { kind: ListingKind };

export const useFilesStore = defineStore('files', () => {
  const view = useViewStore();
  const toast = useToastStore();
  const t = i18n.global.t;

  const storages = ref<Storage[]>([]);
  /** The active storage; the UI shows one storage until multi-storage navigation lands. */
  const storage = computed(() => storages.value[0] ?? null);
  const user = ref<User | null>(null);
  /** Current folder in the folder view; null on the flat listings. */
  const folder = ref<Node | null>(null);
  const path = ref<Node[]>([]);
  const items = ref<Node[]>([]);
  const people = ref<Person[]>([]);
  const listing = ref<Listing | null>(null);
  /** Bumped after every mutation; pages that keep their own data (Home, Search) reload on it. */
  const revision = ref(0);
  // Out-of-order guard: only the newest `load` may publish its result.
  let loadSeq = 0;

  const sorted = computed(() => {
    // Recent is a timeline: its day groups only make sense newest-first.
    const recent = listing.value?.kind === 'recent';
    const key = recent ? 'modified' : view.sortKey;
    const dir = recent || view.sortDir === 'desc' ? -1 : 1;
    // The trash shows a "Deleted" column instead of "Last modified", so its date sort follows that column;
    // Recent is ordered by the last open, with the modification as the fallback (see `listRecent`).
    const date = (n: Node) => {
      if (listing.value?.kind === 'trash') return n.deletedAt ?? n.modifiedAt;
      if (recent) return n.openedAt ?? n.modifiedAt;
      return n.modifiedAt;
    };
    const cmp = (a: Node, b: Node): number => {
      switch (key) {
        case 'modified':
          return (Date.parse(date(a)) - Date.parse(date(b))) * dir;
        case 'size':
          return (a.size - b.size) * dir;
        default:
          return a.name.localeCompare(b.name, i18n.global.locale.value, { sensitivity: 'base' }) * dir;
      }
    };
    return [...items.value].sort(cmp);
  });
  const folders = computed(() => sorted.value.filter((n) => n.kind === 'folder'));
  const files = computed(() => sorted.value.filter((n) => n.kind === 'file'));
  /** Folders first, then files — the visual order used for shift-click ranges. */
  const ordered = computed(() => [...folders.value, ...files.value]);

  const selection = useSelection(ordered);
  const { selected } = selection;
  /** The node the details panel describes: the single selection, else the current folder. */
  const focusNode = computed(() => (selected.value.length === 1 ? selected.value[0] : folder.value));

  watch(focusNode, async (node) => {
    const list = node ? await repository.listPeople(node.id) : [];
    // A faster selection change may have resolved meanwhile; keep the newest node's list.
    if (focusNode.value?.id === node?.id) people.value = list;
  });

  async function load(target: Listing) {
    const seq = ++loadSeq;
    if (target.kind === 'folder') {
      const [node, chain, list] = await Promise.all([
        repository.getNode(target.folderId),
        repository.getPath(target.folderId),
        repository.listFolder(target.folderId),
      ]);
      if (seq !== loadSeq) return;
      folder.value = node;
      path.value = chain;
      items.value = list;
    } else {
      const loaders = {
        recent: repository.listRecent,
        starred: repository.listStarred,
        shared: repository.listShared,
        trash: repository.listTrash,
      } satisfies Record<ListingKind, () => Promise<Node[]>>;
      const list = await loaders[target.kind].call(repository);
      if (seq !== loadSeq) return;
      folder.value = null;
      path.value = [];
      items.value = list;
    }
    listing.value = target;
  }

  /** Pages without a listing (Home, Search) leave no folder behind: "New" and uploads then land in the root. */
  function leave() {
    loadSeq++;
    listing.value = null;
    folder.value = null;
    path.value = [];
    items.value = [];
    selection.clear();
    selection.focusedId.value = null;
  }

  // The selection is dropped before the load, so whoever reacts to the new listing (details panel, dev hooks)
  // sees it clean rather than the old one vanishing a tick later.
  async function open(folderId: string) {
    selection.clear();
    selection.focusedId.value = null;
    await load({ kind: 'folder', folderId });
  }

  /** Opens the folder at `path` (slash-separated, relative to the active storage root). */
  async function openPath(path: string) {
    if (!storage.value) throw new Error('storage not loaded');
    const node = await repository.resolvePath(storage.value.id, path);
    await open(node.id);
  }

  async function openListing(kind: ListingKind) {
    selection.clear();
    selection.focusedId.value = null;
    await load({ kind });
  }

  /** Re-reads the current listing after a mutation; ids that vanished simply drop out of the selection. */
  async function refresh() {
    if (listing.value) await load(listing.value);
  }

  async function bootstrap() {
    [storages.value, user.value] = await Promise.all([repository.listStorages(), repository.currentUser()]);
  }

  async function mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = await action();
    revision.value++;
    await refresh();
    return result;
  }

  /** Where "New" and uploads land: the open folder, else the storage root. */
  const targetFolderId = computed(() => folder.value?.id ?? storage.value?.rootId ?? null);

  async function createFolder(name: string) {
    const parentId = targetFolderId.value;
    if (!parentId) throw new Error('storage not loaded');
    const node = await mutate(() => repository.createFolder(parentId, name));
    if (folder.value?.id === parentId) selection.select(node.id);
    return node;
  }

  async function addUploaded(parentId: string, file: UploadInput) {
    return mutate(() => repository.uploadFile(parentId, file));
  }

  async function rename(id: string, name: string) {
    await mutate(() => repository.rename(id, name));
  }

  async function restore(nodes: Node[]) {
    await mutate(() => repository.restore(nodes.map((n) => n.id)));
    toast.push(subjectMessage(t, 'toast.restored', nodes));
  }

  /** Moves to trash and offers Undo in a toast (spec §7). */
  async function trash(nodes: Node[]) {
    await mutate(() => repository.moveToTrash(nodes.map((n) => n.id)));
    toast.push(subjectMessage(t, 'toast.movedToTrash', nodes), { label: t('toast.undo'), run: () => void restore(nodes) });
  }

  // Permanent deletion invalidates any pending Undo: restoring a node that is gone would throw.
  async function deleteForever(nodes: Node[]) {
    toast.dismissActions();
    await mutate(() => repository.deleteForever(nodes.map((n) => n.id)));
    toast.push(subjectMessage(t, 'toast.deletedForever', nodes));
  }

  async function emptyTrash() {
    toast.dismissActions();
    await mutate(() => repository.emptyTrash());
    toast.push(t('toast.trashEmptied'));
  }

  async function setStarred(nodes: Node[], starred: boolean) {
    await mutate(() => repository.setStarred(nodes.map((n) => n.id), starred));
    toast.push(subjectMessage(t, starred ? 'toast.starred' : 'toast.unstarred', nodes));
  }

  async function move(nodes: Node[], target: Node) {
    await mutate(() => repository.move(nodes.map((n) => n.id), target.id));
    toast.push(subjectMessage(t, 'toast.moved', nodes, { folder: target.name }));
  }

  async function createShareLink(id: string) {
    return mutate(() => repository.createShareLink(id));
  }

  async function removeShareLink(id: string) {
    await mutate(() => repository.removeShareLink(id));
  }

  return {
    storages,
    storage,
    user,
    folder,
    path,
    items,
    people,
    listing,
    revision,
    folders,
    files,
    selected,
    focusNode,
    ordered,
    targetFolderId,
    allState: selection.allState,
    focusedId: selection.focusedId,
    cursorId: selection.cursorId,
    open,
    openPath,
    openListing,
    leave,
    refresh,
    bootstrap,
    createFolder,
    addUploaded,
    rename,
    trash,
    restore,
    deleteForever,
    emptyTrash,
    setStarred,
    move,
    createShareLink,
    removeShareLink,
    select: selection.select,
    selectFromEvent: selection.selectFromEvent,
    toggle: selection.toggle,
    selectAll: selection.selectAll,
    isSelected: selection.isSelected,
    clearSelection: selection.clear,
    handleKeydown: selection.handleKeydown,
  };
});
