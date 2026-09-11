import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useSelection } from '@/composables/useSelection';
import { emptyFilter, isFiltered } from '@/features/files/filters';
import { repository } from '@/data';
import { matchesFilter } from '@/data/listingFilter';
import { NOT_FOUND, ROLE_FORBIDDEN } from '@/data/repository';
import type { ListingFilter, Node, Person, Storage, UploadInput, UploadOptions, User } from '@/data/types';
import { i18n } from '@/i18n';
import { errorMessage } from '@/lib/errors';
import { subjectMessage } from '@/i18n/subject';
import { useToastStore } from './toast';
import { useUndoStore } from '@/features/files/undoStore';
import { useOperationsStore } from '@/features/files/operationsStore';
import { useViewStore } from './view';

/** Flat listings that reuse the table, selection and sort of the folder view. */
export type ListingKind = 'recent' | 'starred' | 'shared' | 'trash';
type Listing = { kind: 'folder'; folderId: string } | { kind: ListingKind };

/**
 * The drive that holds the users' own files. It is a name and not a flag because filex marks no drive as such: `main`
 * is what every installation calls it, and the server lists it like any other mount.
 */
export const HOME_STORAGE = 'main';

/**
 * A folder with fewer live children than this is held whole and the chips sieve it in memory: one request per
 * folder instead of one per chip change. From this size up the server filters, and every chip change is a request.
 */
const CLIENT_FILTER_MAX = 1000;
/** How long the name box waits for the next keystroke before a large folder is asked again. */
const NAME_DEBOUNCE_MS = 250;

export const useFilesStore = defineStore('files', () => {
  const view = useViewStore();
  const toast = useToastStore();
  const undo = useUndoStore();
  const operations = useOperationsStore();
  const t = i18n.global.t;

  const storages = ref<Storage[]>([]);
  /**
   * The drive a files route with no drive in it opens — the one "My files" leads to.
   *
   * `HOME_STORAGE` when it is mounted, and otherwise simply the first drive there is: nothing guarantees an
   * installation calls its home drive `main`, and the demo dataset has a single drive named `demo`. Deriving the
   * default from the drive list rather than from the constant is what keeps "My files" and the drive rows in step —
   * against a dataset without `main`, the constant made "My files" name a drive that is not there.
   */
  const homeStorageId = computed(() =>
    storages.value.some((s) => s.id === HOME_STORAGE) ? HOME_STORAGE : storages.value[0]?.id ?? null,
  );
  /**
   * The drives the "Storages" section lists: every one but the home drive.
   *
   * The home drive holds the users' own files — their home, the way `/home` is — and "My files" is how it is
   * reached. Listing it beside the extra mounts made it look like one more drive to pick, which it is not, and
   * would light two rows at once for the same listing.
   */
  const listedStorages = computed(() => storages.value.filter((s) => s.id !== homeStorageId.value));
  /**
   * The drive the folder view is in, by id.
   *
   * Null until navigation names one, which is what makes the home drive the default: `/files` with no drive in
   * it, and the flat listings (recent, starred, shared, trash), which span every drive and name none.
   */
  const storageId = ref<string | null>(null);
  /**
   * The open drive; the home drive while nothing has been opened, or the first one on an installation without a
   * home drive. A drive that is gone falls back the same way.
   */
  const storage = computed(
    () => storages.value.find((s) => s.id === storageId.value) ?? storages.value.find((s) => s.id === homeStorageId.value) ?? null,
  );
  const user = ref<User | null>(null);
  /** Current folder in the folder view; null on the flat listings. */
  const folder = ref<Node | null>(null);
  const path = ref<Node[]>([]);
  const items = ref<Node[]>([]);
  const people = ref<Person[]>([]);
  /** Whether this account may CHANGE the access list of the focused node; reading it needs far less. */
  const canManagePeople = ref(false);
  const focusPath = ref<Node[]>([]);
  /** Chips and the name box above the listing. Sent to the repository, except for a small folder — see `local`. */
  const filter = ref<ListingFilter>(emptyFilter());
  const filtered = computed(() => isFiltered(filter.value));
  /**
   * The open folder is small (under `CLIENT_FILTER_MAX` live children): `items` hold ALL of it, unfiltered, and
   * `visible` sieves them here. Otherwise `items` are what the server answered for the filter. Flat listings are
   * always the server's answer.
   */
  const local = ref(false);
  /** How many rows the listing has before the filter: the server's count for a folder, the row count elsewhere. */
  const total = ref(0);
  const visible = computed(() =>
    local.value && listing.value?.kind === 'folder' ? items.value.filter((n) => matchesFilter(n, filter.value)) : items.value,
  );
  const filterPeople = ref<Person[]>([]);
  const listing = ref<Listing | null>(null);
  /** True while the newest load is in flight; the pages show a skeleton instead of an empty listing. */
  const loading = ref(false);
  /** Whether `bootstrap` has settled — either way. A page must not read an empty drive list as "no drives yet". */
  const ready = ref(false);
  /** i18n key under `error.` when the last load failed, so the page can offer a retry instead of a blank listing. */
  const error = ref<'notFound' | 'load' | null>(null);
  /** Bumped after every mutation; pages that keep their own data (Home, Search) reload on it. */
  const revision = ref(0);
  // Out-of-order guard: only the newest `load` may publish its result.
  let loadSeq = 0;
  /** Drive and path of the last `openPath`, so a retry can resolve the same address again. */
  let lastAddress: { drive: string | null; path: string } | null = null;

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
    return [...visible.value].sort(cmp);
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
    const forget = () => {
      people.value = [];
      canManagePeople.value = false;
      focusPath.value = [];
    };
    if (!node) return forget();
    let access: { people: Person[]; canManage: boolean };
    let chain: Node[];
    try {
      [access, chain] = await Promise.all([repository.listPeople(node.id), repository.getPath(node.id)]);
    } catch {
      // A node this account may not read (403) tells us nothing about itself. Keeping what the PREVIOUS node
      // answered would leave the panel showing that node's people and location under this node's name.
      if (focusNode.value?.id === node.id) forget();
      return;
    }
    // A faster selection change may have resolved meanwhile; keep the newest node's answers.
    if (focusNode.value?.id !== node.id) return;
    people.value = access.people;
    canManagePeople.value = access.canManage;
    focusPath.value = chain;
  }, { immediate: true });

  /** The debounce of the name box on a large folder; a chip change or a navigation cancels it. */
  let nameTimer: ReturnType<typeof setTimeout> | undefined;

  async function load(target: Listing) {
    // A pending name-box debounce belongs to the listing being left: it calls `refresh()`, which reads
    // `listing.value` — still the OLD folder until this load resolves — so letting it fire would reload the
    // folder the person just navigated away from and drop this navigation as the stale one.
    clearTimeout(nameTimer);
    // Another listing: the rows on screen are the previous folder's. Keeping them until the answer arrived showed
    // the old files under the new folder for as long as the request took. A refresh of the SAME listing keeps its
    // rows, so a mutation or a filter change does not blink a skeleton over a listing that is already right.
    if (listingKey(listing.value) !== listingKey(target)) clearRows();
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
    // The People chip's options are learned from the rows a listing carried (the HTTP repository has no other
    // way to know who owns what), so they are re-read after every listing rather than only at bootstrap. On its
    // own request, though: sharing the listing's `try` meant a refused chip threw away a listing that had arrived
    // and put "Could not load this listing" over it. The chip keeps the options it had instead.
    try {
      const people = await repository.listFilterPeople();
      if (seq === loadSeq) filterPeople.value = people;
    } catch {
      // no new options for the chip; the listing is not affected
    }
  }

  /** Identity of a listing, for telling a navigation from a re-read of what is already open. */
  function listingKey(target: Listing | null) {
    if (!target) return '';
    return target.kind === 'folder' ? `folder:${target.folderId}` : target.kind;
  }

  /** Drops the rows of the listing being left, so the pages draw their skeleton instead of stale files. */
  function clearRows() {
    items.value = [];
    total.value = 0;
  }

  async function read(target: Listing, seq: number) {
    if (target.kind === 'folder') {
      // A tag filter is the server's alone — no listing row carries its tags, so nothing here could sieve by one.
      // While one is set the folder is never held whole, however small it is.
      const sievable = !filter.value.tags.length;
      // A folder already known to be small is asked for whole: the chips sieve it here, and a mutation in a filtered
      // folder costs one request rather than two.
      const sieve = sievable && local.value && folder.value?.id === target.folderId;
      const [node, chain, first] = await Promise.all([
        repository.getNode(target.folderId),
        repository.getPath(target.folderId),
        repository.listFolder(target.folderId, sieve ? emptyFilter() : filter.value),
      ]);
      if (seq !== loadSeq) return;
      const small = first.total < CLIENT_FILTER_MAX;
      // The answer's size disagrees with what the request assumed: a small folder was asked for filtered (its rows
      // must be the whole folder), or a folder that grew large was asked for whole. Once more, the other way.
      const page = !sievable || small === sieve || !isFiltered(filter.value)
        ? first
        : await repository.listFolder(target.folderId, small ? emptyFilter() : filter.value);
      if (seq !== loadSeq) return;
      folder.value = node;
      path.value = chain;
      items.value = page.nodes;
      total.value = page.total;
      local.value = small && sievable;
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
      total.value = list.length;
      local.value = false;
    }
    listing.value = target;
  }

  /** Pages without a listing (Home, Search) leave no folder behind: "New" and uploads then land in the root. */
  function leave() {
    loadSeq++;
    listing.value = null;
    folder.value = null;
    path.value = [];
    clearRows();
    selection.clear();
    selection.focusedId.value = null;
  }

  // The selection is dropped before the load, so whoever reacts to the new listing (details panel, dev hooks)
  // sees it clean rather than the old one vanishing a tick later.
  async function open(folderId: string) {
    // "Filter in this folder": the name box belongs to the folder it was typed in.
    filter.value = { ...filter.value, name: '' };
    selection.clear();
    selection.focusedId.value = null;
    await load({ kind: 'folder', folderId });
  }

  /**
   * Opens the folder at `path` (slash-separated, relative to the drive root) on the drive named by `driveId`.
   *
   * The drive is switched BEFORE the folder is resolved, so the sidebar, the quota block and the search
   * placeholder move together with the listing instead of lagging a navigation behind. A drive nobody has heard
   * of is the same answer as a folder nobody has heard of — the not-found state, not a silent fallback that would
   * open somebody else's files under the URL they typed.
   */
  async function openPath(driveId: string | null, folderPath: string) {
    // A drive nobody has heard of is the same answer as a folder nobody has heard of. The active drive is left
    // where it was rather than moved to a name that does not resolve, so the sidebar keeps saying where you are.
    const previous = lastAddress;
    lastAddress = { drive: driveId, path: folderPath };
    // Resolving the address is a request of its own, and `load` — which owns the loading flag — only starts after
    // it answers. Without this the rows of the folder being left stayed on screen, unmarked, for that whole round
    // trip: the breadcrumb had already moved, so the new folder appeared to hold the old files.
    if (!previous || previous.drive !== driveId || previous.path !== folderPath) {
      clearRows();
      loading.value = true;
    }
    if (driveId && !storages.value.some((s) => s.id === driveId)) {
      showFailure('notFound');
      return;
    }
    storageId.value = driveId;
    // No drives at all means the list never arrived; that is the server's failure, not a wrong address.
    if (!storage.value) {
      showFailure('load');
      return;
    }
    // Resolving the address is a request of its own, and it is made BEFORE any load exists to guard its result.
    // Over HTTP it can come back after the person has already navigated somewhere else — a slow folder answering
    // last used to open itself over the listing that is now on screen. The same counter decides that here.
    const seq = ++loadSeq;
    let node: Node;
    try {
      node = await repository.resolvePath(storage.value.id, folderPath);
    } catch (e) {
      // A folder that is GONE and a server that did not answer are two different sentences, and only the
      // repository knows which it was (`NOT_FOUND`). Saying "renamed, moved or deleted" for a 500 or a dropped
      // connection told people their files were gone every time the network blinked.
      if (seq === loadSeq) showFailure(errorMessage(e) === NOT_FOUND ? 'notFound' : 'load');
      return;
    }
    if (seq !== loadSeq) return;
    await open(node.id);
  }

  /**
   * The address led nowhere: clear the listing and say WHICH kind of nowhere, rather than leaving a blank page
   * behind — or, worse, the empty-folder state, which is a claim about the folder's contents that a failed
   * request gives nobody the right to make.
   */
  function showFailure(kind: 'notFound' | 'load') {
    loadSeq++;
    selection.clear();
    clearRows();
    folder.value = null;
    path.value = [];
    listing.value = null;
    loading.value = false;
    error.value = kind;
  }

  async function openListing(kind: ListingKind) {
    lastAddress = null;
    filter.value = { ...filter.value, name: '' };
    selection.clear();
    selection.focusedId.value = null;
    await load({ kind });
  }

  /** Runs the failed load again: the folder behind the URL, else the open listing. */
  async function retry() {
    if (!storages.value.length) {
      await bootstrap();
      if (error.value) return;
    }
    if (lastAddress) return openPath(lastAddress.drive, lastAddress.path);
    if (listing.value) return load(listing.value);
  }

  /** Re-reads the current listing after a mutation; ids that vanished simply drop out of the selection. */
  async function refresh() {
    if (listing.value) await load(listing.value);
  }

  /**
   * Something outside this store changed the files — an approved assistant plan runs on the server. The same
   * two steps `mutate` takes: the pages that keep their own data reload on the revision, the listing is re-read.
   */
  async function reload() {
    revision.value++;
    await refresh();
  }

  /**
   * The drive list, the account and the people filter — everything a page needs before it can ask for anything.
   *
   * A failure here is the server being unreachable, and it MUST land in `error`: without this the rejection went
   * nowhere, `storages` stayed empty, and the folder page drew its "Drop files here" empty state — which reads as
   * "your drive is empty" when the truth is "nobody answered". `ready` is what lets a page tell the two apart from
   * the moment before the answer arrives.
   */
  async function bootstrap() {
    try {
      [storages.value, user.value] = await Promise.all([repository.listStorages(), repository.currentUser()]);
      error.value = null;
    } catch {
      error.value = 'load';
    } finally {
      ready.value = true;
    }
    // The People chip's options, off the critical path: they were in the `Promise.all` above, so a server that
    // answered the drives and the account but refused this one started the app in the "could not load" state.
    try {
      filterPeople.value = await repository.listFilterPeople();
    } catch {
      // the chip has no options; nothing else here depends on them
    }
  }

  /**
   * A chip or the name box changed. A small folder is already whole in memory and `visible` follows the filter on
   * its own; anything else is the server's question, asked at once for a chip and after a pause for typing.
   */
  async function setFilter(next: ListingFilter) {
    const previous = filter.value;
    const nameOnly =
      next.fileType === previous.fileType &&
      next.modified === previous.modified &&
      next.size === previous.size &&
      next.personId === previous.personId &&
      next.mime === previous.mime &&
      next.around === previous.around &&
      next.tags.length === previous.tags.length &&
      next.tags.every((tag, i) => tag === previous.tags[i]);
    filter.value = next;
    clearTimeout(nameTimer);
    // `local` follows the tags too (see `read`), so a folder held whole is one every chip here can sieve.
    if (listing.value?.kind === 'folder' && local.value && !next.tags.length) return;
    if (nameOnly) {
      nameTimer = setTimeout(() => void refresh(), NAME_DEBOUNCE_MS);
      return;
    }
    await refresh();
  }

  /** The name box: the same filter with a new `name`. */
  function setName(name: string) {
    return setFilter({ ...filter.value, name });
  }

  function clearFilter() {
    return setFilter(emptyFilter());
  }

  async function mutate<T>(action: () => Promise<T>): Promise<T> {
    // The record always describes the LAST action: anything that can be taken back re-arms it once it succeeds.
    undo.clear();
    try {
      return await action();
    } catch (error) {
      // The one refusal no surface in this app can explain on its own: nothing is wrong with the file or the
      // server — the caller's ROLE does not carry the verb, and only an administrator can change that.
      if (errorMessage(error) === ROLE_FORBIDDEN) toast.push(t('common.notAllowed'));
      throw error;
    } finally {
      // Also after a throw. A batch that failed halfway still changed the folder, and a queued job that outlived
      // the wait is changing it right now — leaving the old listing on screen would be the one wrong answer.
      revision.value++;
      await refresh();
    }
  }

  /**
   * Every mutation that nobody else answers for goes through the operations tray: it owns the "still going",
   * the "did not work" and the message, and it is the reason a failed move is no longer silence. `landed` runs
   * only when the work is really done — an Undo for half a move would undo the wrong half.
   *
   * The two verbs NOT here are the ones with an error surface of their own: New folder and Rename put a name
   * collision under their own field, where the name being typed is.
   */
  function queued(nodes: Node[], key: string, action: () => Promise<void>, landed: () => void, extra: Record<string, unknown> = {}) {
    return operations.run(subjectMessage(t, key, nodes, extra), action, landed);
  }

  /** Where "New" and uploads land: the open folder, else the storage root. */
  const targetFolderId = computed(() => folder.value?.id ?? storage.value?.rootId ?? null);

  async function createFolder(name: string) {
    const parentId = targetFolderId.value;
    if (!parentId) throw new Error('storage not loaded');
    const node = await mutate(() => repository.createFolder(parentId, name));
    if (folder.value?.id === parentId) selection.select(node.id);
    // Undo trashes the folder, so putting it back is a restore rather than a second create with a new id.
    undo.record({ undo: () => trash([node]), redo: () => restore([node]) });
    return node;
  }

  /** An empty file, landing where a new folder would; the same selection and the same Undo. */
  async function createFile(name: string) {
    const parentId = targetFolderId.value;
    if (!parentId) throw new Error('storage not loaded');
    const node = await mutate(() => repository.createFile(parentId, name));
    if (folder.value?.id === parentId) selection.select(node.id);
    undo.record({ undo: () => trash([node]), redo: () => restore([node]) });
    return node;
  }

  /**
   * One arriving file. Deliberately NOT through `mutate`: a drop of five hundred files would re-read the folder
   * five hundred times — and, through `focusNode`, ask for the focused node's people and location twice as often
   * again — while throwing away the Undo record on each. The upload store owns the batch and calls
   * `uploadsLanded` once, when the last transfer of it is over.
   */
  async function addUploaded(parentId: string, file: UploadInput, options?: UploadOptions) {
    return repository.uploadFile(parentId, file, options);
  }

  /** The same arrival, for a transfer the server had already started before the page was reloaded. */
  async function addResumed(sessionId: string, parentId: string, file: UploadInput, options?: UploadOptions) {
    return repository.resumeUpload(sessionId, parentId, file, options);
  }

  /** A batch of uploads is over: what `mutate` does after a mutation, paid once for the whole batch. */
  async function uploadsLanded() {
    undo.clear();
    revision.value++;
    await refresh();
  }

  async function rename(id: string, name: string) {
    const before = items.value.find((n) => n.id === id);
    await mutate(() => repository.rename(id, name));
    // An id is a path, so the renamed node answers to a new one; the refresh above lists it under the new name.
    const after = items.value.find((n) => n.name === name && n.parentId === before?.parentId);
    // Renaming back restores the original id (an id is a path), which is what the redo then renames again.
    if (before && after) undo.record({ undo: () => rename(after.id, before.name), redo: () => rename(before.id, name) });
  }

  async function restore(nodes: Node[]) {
    await queued(nodes, 'op.restoring', () => mutate(() => repository.restore(nodes.map((n) => n.id))), () => {
      toast.push(subjectMessage(t, 'toast.restored', nodes));
    });
  }

  /** Moves to trash and offers Undo in a toast (spec §7). */
  async function trash(nodes: Node[]) {
    await queued(nodes, 'op.trashing', () => mutate(() => repository.moveToTrash(nodes.map((n) => n.id))), () => {
      undo.record({ undo: () => restore(nodes), redo: () => trash(nodes) });
      // The toast button and Ctrl+Z are the same step, so pressing both only restores once.
      toast.push(subjectMessage(t, 'toast.movedToTrash', nodes), { label: t('toast.undo'), run: () => void undo.undo() });
    });
  }

  // Permanent deletion invalidates any pending Undo: restoring a node that is gone would throw.
  async function deleteForever(nodes: Node[]) {
    toast.dismissActions();
    await queued(nodes, 'op.deleting', () => mutate(() => repository.deleteForever(nodes.map((n) => n.id))), () => {
      toast.push(subjectMessage(t, 'toast.deletedForever', nodes));
    });
  }

  async function emptyTrash() {
    toast.dismissActions();
    await operations.run(t('op.emptying'), () => mutate(() => repository.emptyTrash()), () => {
      toast.push(t('toast.trashEmptied'));
    });
  }

  async function setStarred(nodes: Node[], starred: boolean) {
    await queued(nodes, 'op.starring', () => mutate(() => repository.setStarred(nodes.map((n) => n.id), starred)), () => {
      undo.record({ undo: () => setStarred(nodes, !starred), redo: () => setStarred(nodes, starred) });
      toast.push(subjectMessage(t, starred ? 'toast.starred' : 'toast.unstarred', nodes));
    });
  }

  async function setTags(node: Node, tags: string[]) {
    await queued([node], 'op.tagging', () => mutate(() => repository.setTags(node.id, tags)), () => {
      toast.push(t('toast.tagsSaved', { name: node.name }));
    });
  }

  async function move(nodes: Node[], target: Node) {
    await queued(nodes, 'op.moving', () => mutate(() => repository.move(nodes.map((n) => n.id), target.id)), () => {
      toast.push(subjectMessage(t, 'toast.moved', nodes, { folder: target.name }));
      // Where each node came from, by name: undo re-resolves the ids in the target, because a moved node's path —
      // and with it its id — has changed.
      const origins = new Map<string, string[]>();
      for (const node of nodes) {
        if (node.parentId) origins.set(node.parentId, [...(origins.get(node.parentId) ?? []), node.name]);
      }
      // After the undo the nodes are back under their own ids, so the redo is simply the same move again.
      if (origins.size) undo.record({ undo: () => moveBack(target.id, origins), redo: () => move(nodes, target) });
    }, { folder: target.name });
  }

  async function moveBack(fromFolderId: string, origins: Map<string, string[]>) {
    const { nodes: landed } = await repository.listFolder(fromFolderId);
    await mutate(async () => {
      for (const [parentId, names] of origins) {
        const ids = landed.filter((n) => names.includes(n.name)).map((n) => n.id);
        if (ids.length) await repository.move(ids, parentId);
      }
    });
  }

  /**
   * Paste of a copy. filex names the copies itself (`<base>-copy<ext>` when the name is taken), so what landed is
   * whatever the open folder gained — which is also what undo has to take away.
   */
  async function copyInto(nodes: Node[], target: Node) {
    const before = new Set(items.value.map((n) => n.id));
    await queued(nodes, 'op.copying', () => mutate(() => repository.copy(nodes.map((n) => n.id), target.id)), () => {
      toast.push(subjectMessage(t, 'toast.copied', nodes, { folder: target.name }));
      const created = items.value.filter((n) => !before.has(n.id));
      if (created.length) undo.record({ undo: () => trash(created), redo: () => restore(created) });
    }, { folder: target.name });
  }

  async function createShareLink(id: string) {
    return mutate(() => repository.createShareLink(id));
  }

  async function removeShareLink(id: string) {
    await mutate(() => repository.removeShareLink(id));
  }

  return {
    storages,
    homeStorageId,
    listedStorages,
    storage,
    ready,
    user,
    folder,
    path,
    items,
    people,
    canManagePeople,
    focusPath,
    loading,
    error,
    filter,
    filtered,
    total,
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
    reload,
    retry,
    setFilter,
    setName,
    clearFilter,
    bootstrap,
    createFolder,
    createFile,
    addUploaded,
    addResumed,
    uploadsLanded,
    rename,
    trash,
    restore,
    deleteForever,
    emptyTrash,
    setStarred,
    setTags,
    move,
    copyInto,
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
