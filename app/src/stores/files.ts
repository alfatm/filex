import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useSelection } from '@/composables/useSelection';
import { emptyFilter, isFiltered } from '@/features/files/filters';
import { repository } from '@/data';
import type { ListingFilter, Node, Person, Storage, UploadInput, User } from '@/data/types';
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
  const focusPath = ref<Node[]>([]);
  /** Chips above the listing. The repository applies them, so every change is a fresh load, as it will be over HTTP. */
  const filter = ref<ListingFilter>(emptyFilter());
  const filtered = computed(() => isFiltered(filter.value));
  const filterPeople = ref<Person[]>([]);
  const listing = ref<Listing | null>(null);
  /** True while the newest load is in flight; the pages show a skeleton instead of an empty listing. */
  const loading = ref(false);
  /** i18n key under `error.` when the last load failed, so the page can offer a retry instead of a blank listing. */
  const error = ref<'notFound' | 'load' | null>(null);
  /** Bumped after every mutation; pages that keep their own data (Home, Search) reload on it. */
  const revision = ref(0);
  // Out-of-order guard: only the newest `load` may publish its result.
  let loadSeq = 0;
  /** Path of the last `openPath`, so a retry can resolve it again. */
  let lastPath: string | null = null;

  const sorted = computed(() => {
    // Recent is a timeline: its day groups only make sense newest-first.
    const recent = listing.value?.kind === 'recent';
    const key = recent ? 'modified' : view.sortKey;
    const dir = recent || view.sortDir === 'desc' ? -1 : 1;
    // The trash shows a "Deleted" column instead of "Last modified", so its date sort follows that column;
    // Recent is ordered by the last open, with the modification as the fallback (see `listRecent`).
    const date = (n: Node) => {
      if (listing.value?.kind === 'trash') return n.deletedAt ?? n.modifiedAt ?? '';
      if (recent) return n.openedAt ?? n.modifiedAt ?? '';
      return n.modifiedAt ?? '';
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

  // Everything the details panel needs about the focused node beyond the node itself. The ancestor chain is loaded
  // here rather than derived from `path`, because the listings beside the tree (Recent, Starred, Shared) describe
  // nodes that are not in the open folder at all — their location has to come from the node.
  watch(focusNode, async (node) => {
    const [list, chain] = node ? await Promise.all([repository.listPeople(node.id), repository.getPath(node.id)]) : [[], []];
    // A faster selection change may have resolved meanwhile; keep the newest node's answers.
    if (focusNode.value?.id !== node?.id) return;
    people.value = list;
    focusPath.value = chain;
  }, { immediate: true });

  async function load(target: Listing) {
    const seq = ++loadSeq;
    loading.value = true;
    error.value = null;
    try {
      await read(target, seq);
    } catch {
      // A newer load already owns the listing; its own result decides what is shown.
      if (seq === loadSeq) {
        error.value = 'load';
        items.value = [];
      }
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  async function read(target: Listing, seq: number) {
    if (target.kind === 'folder') {
      const [node, chain, list] = await Promise.all([
        repository.getNode(target.folderId),
        repository.getPath(target.folderId),
        repository.listFolder(target.folderId, filter.value),
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
      } satisfies Record<ListingKind, (filter: ListingFilter) => Promise<Node[]>>;
      const list = await loaders[target.kind].call(repository, filter.value);
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
  async function openPath(folderPath: string) {
    if (!storage.value) throw new Error('storage not loaded');
    lastPath = folderPath;
    let node: Node;
    try {
      node = await repository.resolvePath(storage.value.id, folderPath);
    } catch {
      // A URL naming a folder that is gone: say so and offer a retry, rather than leaving a blank page behind.
      loadSeq++;
      selection.clear();
      items.value = [];
      folder.value = null;
      path.value = [];
      listing.value = null;
      loading.value = false;
      error.value = 'notFound';
      return;
    }
    await open(node.id);
  }

  async function openListing(kind: ListingKind) {
    lastPath = null;
    selection.clear();
    selection.focusedId.value = null;
    await load({ kind });
  }

  /** Runs the failed load again: the folder behind the URL, else the open listing. */
  async function retry() {
    if (lastPath !== null) return openPath(lastPath);
    if (listing.value) return load(listing.value);
  }

  /** Re-reads the current listing after a mutation; ids that vanished simply drop out of the selection. */
  async function refresh() {
    if (listing.value) await load(listing.value);
  }

  async function bootstrap() {
    [storages.value, user.value, filterPeople.value] = await Promise.all([
      repository.listStorages(),
      repository.currentUser(),
      repository.listFilterPeople(),
    ]);
  }

  /** A chip changed: reload the listing through the repository rather than narrowing what is already in memory. */
  async function setFilter(next: ListingFilter) {
    filter.value = next;
    await refresh();
  }

  function clearFilter() {
    return setFilter(emptyFilter());
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

  async function setTags(node: Node, tags: string[]) {
    await mutate(() => repository.setTags(node.id, tags));
    toast.push(t('toast.tagsSaved', { name: node.name }));
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
    focusPath,
    loading,
    error,
    filter,
    filtered,
    filterPeople,
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
    retry,
    setFilter,
    clearFilter,
    bootstrap,
    createFolder,
    addUploaded,
    rename,
    trash,
    restore,
    deleteForever,
    emptyTrash,
    setStarred,
    setTags,
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
