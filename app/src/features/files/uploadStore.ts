import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import { DUPLICATE_NAME } from '@/data/repository';
import type { Node, UploadSession } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { useSettingsStore, type ConflictBehavior } from '@/features/settings/settingsStore';
import { useModalsStore } from './modalsStore';
import { useOperationsStore } from './operationsStore';
import { previewKind, previewList } from './preview';

/**
 * Where a transfer stands.
 *
 * `queued` is waiting for a slot in the transfer pool, `conflict` is waiting for the person to say what to do
 * about a name that is already taken, and `interrupted` is the one that outlives the page: the server is still
 * holding a staged upload nobody is sending bytes to.
 */
export type UploadState = 'queued' | 'running' | 'conflict' | 'skipped' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** What the tray offers on a row whose name is already taken; the same three the settings offer in advance. */
export type ConflictChoice = Exclude<ConflictBehavior, 'ask'>;

/**
 * How many transfers may be in flight at once.
 *
 * Every one of them is a staged session on the server, with quota reserved against it and a record in
 * localStorage; a drop of five hundred files used to open five hundred of them at the same instant.
 */
export const MAX_PARALLEL_UPLOADS = 3;

export interface UploadItem {
  id: number;
  /** The name the file will land under — `keepBoth` changes it before any bytes are sent. */
  name: string;
  size: number;
  /** 0..100, from the byte count the server has accepted — not from a clock. */
  progress: number;
  state: UploadState;
  /** Where the file is going; an interrupted row needs it to carry on. */
  parentId: string;
  /** The server's id for the staged upload, once `begin` has answered. */
  sessionId?: string;
}

/** What survives a reload, per unfinished transfer. The bytes cannot: a `File` is not serialisable. */
interface StagedRecord {
  id: string;
  parentId: string;
  name: string;
  size: number;
}

/** One file of one batch: its row, its bytes and where it is going. */
interface Entry {
  item: UploadItem;
  file: File;
  parentId: string;
  /** Set once the name question has been answered, so the answer is not asked again on the way back in. */
  resolved?: boolean;
}

const STORAGE_KEY = 'filex.app.uploads';

/** Persisted state is untrusted: anything that is not a full record is dropped. */
function loadRecords(): StagedRecord[] {
  let raw: unknown = [];
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    // unreadable or absent — nothing to pick up
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is StagedRecord =>
    !!r && typeof r === 'object' &&
    typeof (r as StagedRecord).id === 'string' &&
    typeof (r as StagedRecord).parentId === 'string' &&
    typeof (r as StagedRecord).name === 'string' &&
    typeof (r as StagedRecord).size === 'number');
}

function saveRecords(records: StagedRecord[]) {
  try {
    if (records.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — an interrupted upload then simply cannot be picked up
  }
}

/** A DataTransfer, which knows about directories, told apart from the plain file lists the pickers hand over. */
function isTransfer(list: FileList | File[] | DataTransfer): list is DataTransfer {
  return 'items' in list;
}

/**
 * The name a `keepBoth` upload lands under: `<base>-copy<ext>`, then `-copy-2`, … — the shape a paste already
 * uses, so the two ways of ending up with a second copy read the same (backend `ops.uniqueCopyDest`).
 */
function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${stem}-copy${ext}` : `${stem}-copy-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const useUploadStore = defineStore('uploads', () => {
  const files = useFilesStore();
  const modals = useModalsStore();
  const operations = useOperationsStore();
  const settings = useSettingsStore();
  const toast = useToastStore();
  const t = i18n.global.t;

  const items = ref<UploadItem[]>([]);
  const open = computed(() => items.value.length > 0);
  const doneCount = computed(() => items.value.filter((i) => i.state === 'done').length);
  const failedCount = computed(() => items.value.filter((i) => i.state === 'failed').length);
  const interruptedCount = computed(() => items.value.filter((i) => i.state === 'interrupted').length);
  /** Rows that have not settled yet: the tray must not say "complete" while any of them is still going. */
  const pendingCount = computed(() => items.value.filter((i) => i.state === 'queued' || i.state === 'running' || i.state === 'conflict').length);
  let seq = 0;
  /** One controller per running row, so cancelling one transfer leaves the others alone. */
  const running = new Map<number, AbortController>();
  /** What a row in `conflict` is waiting for: the answer its batch will act on. */
  const answers = new Map<number, (choice: ConflictChoice) => void>();

  /**
   * `target` overrides the open folder: a drop on a folder card uploads into that folder. A folder upload arrives
   * as a flat list whose files carry `webkitRelativePath`, so the missing folders of each path are created first.
   *
   * Pass the whole `DataTransfer` of a drop rather than its `files`: only that knows a dropped folder from a file.
   */
  async function start(list: FileList | File[] | DataTransfer, target?: string) {
    const all = pickFiles(list);
    if (!all.length) return;
    const root = await uploadRoot(target);
    if (!root) return;
    // Folders this batch created; nothing can already be inside one, which is a listing not worth asking for.
    const fresh = new Set<string>();
    const chain = new Map<string, string>();
    // Through the operations tray: a tree that cannot be built used to fail into nothing at all — no row in the
    // upload tray (there is none yet) and no message, because every caller of `start` drops the rejection.
    await operations.run(t('op.uploading'), async () => {
      for (const [path, id] of await buildTree(root, all, fresh)) chain.set(path, id);
    });
    // `buildTree` always yields the root, so an empty chain is the failure the tray is now showing.
    if (!chain.size) return;
    // The tree is there long before the first file finishes; show it right away.
    if (chain.size > 1) await files.refresh();

    const entries = all.map<Entry>((file) => {
      const parentId = chain.get(folderPath(file)) ?? root;
      const item: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, state: 'queued', parentId };
      items.value.push(item);
      return { item, file, parentId };
    });
    // Detached on purpose: `start` answers as soon as the folders exist, and the batch runs on behind it.
    void runBatch(entries, fresh);
  }

  /**
   * The files of a drop or a picker.
   *
   * A folder dragged out of the OS file manager arrives as an entry with no bytes and an empty relative path, and
   * it used to go to the server as an ordinary zero-length file named after the folder. Nothing on a `File` says
   * which it is; only the transfer item does (`webkitGetAsEntry().isDirectory`), so a drop hands the whole
   * `DataTransfer` over and the folders are left out — with a line saying how to send one instead.
   */
  function pickFiles(list: FileList | File[] | DataTransfer): File[] {
    if (!isTransfer(list)) return Array.from(list);
    const picked: File[] = [];
    const folders: string[] = [];
    for (const item of Array.from(list.items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        folders.push(entry.name);
        continue;
      }
      const file = item.getAsFile();
      if (file) picked.push(file);
    }
    if (folders.length) toast.push(t('upload.folderDropped', { name: folders[0], count: folders.length }, folders.length));
    return picked;
  }

  /**
   * Where this upload lands. The context wins — a drop on a folder card, or the open folder — and the default
   * upload folder is what answers when there is none: the sidebar's Upload on Home, on Search, on the trash.
   *
   * ⚠ A node id here IS its path, so the saved folder stops existing the moment somebody renames it. That is
   * checked before the transfer rather than discovered by it: the upload falls back to the drive root and says so.
   */
  async function uploadRoot(target?: string): Promise<string | null> {
    if (target) return target;
    if (files.folder) return files.folder.id;
    const saved = settings.settings.defaultUploadFolder;
    if (!saved) return files.targetFolderId;
    try {
      const node = await repository.getNode(saved);
      if (node.kind === 'folder') return node.id;
    } catch {
      // renamed, moved, deleted or not readable any more — the fallback below is the answer either way
    }
    toast.push(t('upload.defaultFolderGone', { folder: files.storage?.name ?? '' }));
    return files.targetFolderId;
  }

  /** The folder a dropped file belongs in, relative to the drop target. "" for a plain file selection. */
  function folderPath(file: File): string {
    return file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : '';
  }

  /**
   * The folders a dropped tree needs, keyed by their path under `root`.
   *
   * Built a LEVEL at a time rather than a file at a time. Every folder on one level is independent — their parents
   * are all resolved by then — so they are created together, and the cost of a hundred-folder drop becomes the
   * tree's depth instead of a hundred waits in a row. The old walk also asked for a full listing of the parent
   * before every single folder, to find out whether the name was taken.
   */
  async function buildTree(root: string, list: File[], fresh: Set<string>): Promise<Map<string, string>> {
    const chain = new Map<string, string>([['', root]]);
    // Every folder the drop implies, including intermediate ones holding no file of their own.
    const levels: Set<string>[] = [];
    for (const file of list) {
      const parts = folderPath(file) ? folderPath(file).split('/') : [];
      parts.forEach((_, i) => {
        (levels[i] ??= new Set()).add(parts.slice(0, i + 1).join('/'));
      });
    }
    for (const level of levels) {
      const paths = [...level];
      const made = await Promise.all(
        paths.map((path) => {
          const cut = path.lastIndexOf('/');
          return folderAt(chain.get(cut < 0 ? '' : path.slice(0, cut))!, path.slice(cut + 1), fresh);
        }),
      );
      paths.forEach((path, i) => chain.set(path, made[i]));
    }
    return chain;
  }

  /**
   * One folder: created, or found where it already was.
   *
   * Create FIRST and read the collision as the answer. Asking "is it there" costs a whole listing of the parent —
   * every row of it, to decide one boolean — and for a folder being uploaded the usual answer is "no". The listing
   * still happens on a collision, which is exactly when it is worth paying for.
   */
  async function folderAt(parentId: string, name: string, fresh: Set<string>): Promise<string> {
    try {
      const made = (await repository.createFolder(parentId, name)).id;
      // Just created, so it is empty: no name in it can clash, and no listing has to say so.
      fresh.add(made);
      return made;
    } catch (error) {
      if ((error as Error).message !== DUPLICATE_NAME) throw error;
      const existing = (await repository.listFolder(parentId)).find((n) => n.kind === 'folder' && n.name === name);
      if (!existing) throw error;
      return existing.id;
    }
  }

  /**
   * One batch of files, at most `MAX_PARALLEL_UPLOADS` of them in flight.
   *
   * A row waiting for an answer about its name holds no slot — it leaves the queue and the answer puts it back —
   * so a batch does not stall behind the first three names the person has not decided about yet.
   *
   * The listing is re-read ONCE, when the last transfer of the batch is over. It used to be re-read by every
   * single file, which for a folder drop meant N listings of the folder, twice as many requests from the details
   * panel behind them, and the Undo record thrown away N times.
   */
  async function runBatch(entries: Entry[], fresh: Set<string>) {
    const queue = [...entries];
    /** Names already in each target folder, learned at most once per folder per batch. */
    const listed = new Map<string, Set<string>>();
    const asking = new Set<number>();
    const landed: Node[] = [];
    let active = 0;
    let finish!: () => void;
    const over = new Promise<void>((resolve) => (finish = resolve));

    async function namesIn(parentId: string): Promise<Set<string>> {
      const known = listed.get(parentId);
      if (known) return known;
      const names = fresh.has(parentId)
        ? new Set<string>()
        // The open folder's listing is already in memory; a second copy of it is a request for nothing.
        : files.folder?.id === parentId
          ? new Set(files.items.map((n) => n.name))
          : new Set((await repository.listFolder(parentId)).map((n) => n.name));
      listed.set(parentId, names);
      return names;
    }

    function pump() {
      while (active < MAX_PARALLEL_UPLOADS && queue.length) {
        const entry = queue.shift()!;
        active++;
        void step(entry).finally(() => {
          active--;
          pump();
        });
      }
      if (!active && !queue.length && !asking.size) finish();
    }

    async function step(entry: Entry) {
      // Cancelled while it waited for a slot: the row has already said what it is.
      if (entry.item.state !== 'queued') return;
      const rule = settings.settings.conflictBehavior;
      // "Replace" is the server's own behaviour for a name that is taken, so it needs to know nothing in advance.
      if (rule !== 'replace' && !entry.resolved) {
        const names = await namesIn(entry.parentId);
        if (names.has(entry.item.name)) {
          if (rule === 'skip') {
            entry.item.state = 'skipped';
            return;
          }
          if (rule === 'keepBoth') entry.item.name = freeName(entry.item.name, names);
          else return ask(entry, names);
        }
        // Two files of one batch under one name would otherwise collide with each other, unseen by any listing.
        names.add(entry.item.name);
      }
      entry.item.state = 'running';
      const node = await run(entry.item, (options) =>
        files.addUploaded(entry.parentId, { name: entry.item.name, size: entry.file.size, blob: entry.file }, options),
      );
      if (node) landed.push(node);
    }

    /** Puts the question in the tray, beside the row it is about, and steps out of the way until it is answered. */
    function ask(entry: Entry, names: Set<string>) {
      entry.item.state = 'conflict';
      asking.add(entry.item.id);
      answers.set(entry.item.id, (choice) => {
        answers.delete(entry.item.id);
        asking.delete(entry.item.id);
        if (choice === 'skip') {
          entry.item.state = 'skipped';
        } else {
          if (choice === 'keepBoth') entry.item.name = freeName(entry.item.name, names);
          names.add(entry.item.name);
          entry.resolved = true;
          entry.item.state = 'queued';
          // An answered row goes first: the person is waiting on that one.
          queue.unshift(entry);
        }
        pump();
      });
    }

    pump();
    await over;
    await files.uploadsLanded();
    // Only for a single file. A preview thrown over a folder drop would be in the way of the thing it interrupts,
    // and there would be no honest answer to "which of the five hundred".
    if (settings.settings.autoOpenPreview && entries.length === 1 && landed.length === 1) {
      const node = files.files.find((n) => n.id === landed[0].id) ?? landed[0];
      if (previewKind(node) !== 'none') modals.open({ kind: 'preview', ...previewList(files.files, node) });
    }
  }

  /** The person's answer to a name that is already taken; ignored for a row that is not asking. */
  function decide(id: number, choice: ConflictChoice) {
    answers.get(id)?.(choice);
  }

  /**
   * The half every transfer shares: a controller the cancel button can pull, the progress into the row, and the
   * outcome written where the tray reads it. `send` gets the options because a fresh upload and a resumed one
   * differ only in which repository call they make. It answers with what landed, or nothing if it did not.
   */
  async function run<T>(item: UploadItem, send: (options: Parameters<typeof files.addUploaded>[2]) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController();
    running.set(item.id, controller);
    const live = () => items.value.find((i) => i.id === item.id);
    try {
      const landed = await send({
        signal: controller.signal,
        onSession: (id) => {
          const row = live();
          if (row) row.sessionId = id;
          remember({ id, parentId: item.parentId, name: item.name, size: item.size });
        },
        onProgress: (sent, total) => {
          const row = live();
          if (row) row.progress = total ? Math.min(100, (100 * sent) / total) : 100;
        },
      });
      const row = live();
      if (row) {
        row.progress = 100;
        row.state = 'done';
      }
      forget(item.sessionId ?? live()?.sessionId);
      return landed;
    } catch {
      // The store's own error banner is for the listing; a failed transfer belongs to its row in the tray.
      const row = live();
      // A cancelled row has already said what it is; a failure must not overwrite that.
      if (row && row.state === 'running') row.state = controller.signal.aborted ? 'cancelled' : 'failed';
      // ⚠ A failed transfer keeps its record: the server is still holding what it accepted, and the next load
      // offers to carry on from there. Only a cancel throws the staged bytes away.
      if (controller.signal.aborted) forget(live()?.sessionId);
      return undefined;
    } finally {
      running.delete(item.id);
    }
  }

  /** Stops a running transfer and drops what the server has staged for it. */
  async function cancel(id: number) {
    const row = items.value.find((i) => i.id === id);
    if (!row) return;
    running.get(id)?.abort();
    row.state = 'cancelled';
    await drop(row.sessionId);
  }

  /**
   * Picks up an interrupted transfer. The person has to hand over the file again — the page has no bytes after a
   * reload, and a `File` cannot be stored — so this refuses anything that is not the file the session was begun
   * for, as far as a name and a size can tell.
   */
  async function resume(id: number, file: File): Promise<boolean> {
    const row = items.value.find((i) => i.id === id);
    if (!row || !row.sessionId || row.state !== 'interrupted') return false;
    if (file.name !== row.name || file.size !== row.size) return false;
    row.state = 'running';
    const session = row.sessionId;
    await run(row, (options) => files.addResumed(session, row.parentId, { name: file.name, size: file.size, blob: file }, options));
    await files.uploadsLanded();
    return true;
  }

  /** Gives up on an interrupted transfer: the row goes and so do the staged bytes. */
  async function discard(id: number) {
    const row = items.value.find((i) => i.id === id);
    if (!row) return;
    items.value = items.value.filter((i) => i.id !== id);
    await drop(row.sessionId);
  }

  /**
   * Rebuilds the tray from what the server still holds. Called once, when the app starts: a reload leaves staged
   * uploads on the server that nobody is sending bytes to, and without this they are invisible until they expire.
   *
   * A session the server no longer knows is dropped silently — it committed, expired or was aborted elsewhere, and
   * a row offering to resume it would be a button that cannot work.
   */
  async function restore() {
    const records = loadRecords();
    if (!records.length) return;
    const alive: StagedRecord[] = [];
    for (const record of records) {
      let session: UploadSession | null;
      try {
        session = await repository.uploadSession(record.id);
      } catch {
        // Nobody ANSWERED — which says nothing about the session. The server is still holding the staged bytes and
        // the quota reserved against them, so the record survives the failure and the next start asks again;
        // erasing it here would leave that reservation with nothing left to release it.
        alive.push(record);
        continue;
      }
      // The server DID answer, and said it no longer knows the session: it committed, expired or was aborted
      // elsewhere, and a row offering to resume it would be a button that cannot work.
      if (!session) continue;
      alive.push(record);
      items.value.push({
        id: ++seq,
        name: record.name,
        size: record.size,
        parentId: record.parentId,
        sessionId: record.id,
        progress: record.size ? Math.min(100, (100 * session.offset) / record.size) : 0,
        state: 'interrupted',
      });
    }
    saveRecords(alive);
  }

  function remember(record: StagedRecord) {
    saveRecords([...loadRecords().filter((r) => r.id !== record.id), record]);
  }

  function forget(sessionId?: string) {
    if (!sessionId) return;
    saveRecords(loadRecords().filter((r) => r.id !== sessionId));
  }

  /** Forget it here and drop it there. The server's copy is the one that holds disk and quota. */
  async function drop(sessionId?: string) {
    forget(sessionId);
    if (!sessionId) return;
    await repository.abortUpload(sessionId).catch(() => {
      // Already gone, or the server refused: the sweeper collects it either way.
    });
  }

  /**
   * Closing the tray drops the rows that are over. A transfer still going keeps going — queued and waiting-on-an-
   * answer rows included — and an interrupted one stays: it is the only place its Resume button lives, and the
   * staged bytes behind it are real.
   */
  function clear() {
    items.value = items.value.filter(
      (i) => i.state === 'running' || i.state === 'queued' || i.state === 'conflict' || i.state === 'interrupted',
    );
  }

  return { items, open, doneCount, failedCount, interruptedCount, pendingCount, start, cancel, decide, resume, discard, restore, clear };
});
