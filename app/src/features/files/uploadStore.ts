import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import { DUPLICATE_NAME } from '@/data/repository';
import { useFilesStore } from '@/stores/files';

/**
 * Where a transfer stands. `interrupted` is the one that outlives the page: the
 * server is still holding a staged upload nobody is sending bytes to.
 */
export type UploadState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface UploadItem {
  id: number;
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

export const useUploadStore = defineStore('uploads', () => {
  const files = useFilesStore();
  const items = ref<UploadItem[]>([]);
  const open = computed(() => items.value.length > 0);
  const doneCount = computed(() => items.value.filter((i) => i.state === 'done').length);
  const failedCount = computed(() => items.value.filter((i) => i.state === 'failed').length);
  const interruptedCount = computed(() => items.value.filter((i) => i.state === 'interrupted').length);
  let seq = 0;
  /** One controller per running row, so cancelling one transfer leaves the others alone. */
  const running = new Map<number, AbortController>();

  /**
   * `target` overrides the open folder: a drop on a folder card uploads into that folder. A folder upload arrives
   * as a flat list whose files carry `webkitRelativePath`, so the missing folders of each path are created first.
   */
  async function start(list: FileList | File[], target?: string) {
    const root = target ?? files.targetFolderId;
    if (!root) return;
    const all = Array.from(list);
    const chain = await buildTree(root, all);
    for (const file of all) {
      void transfer(file, chain.get(folderPath(file)) ?? root);
    }
    // The tree is there long before the first file finishes; show it right away.
    if (chain.size > 1) await files.refresh();
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
  async function buildTree(root: string, list: File[]): Promise<Map<string, string>> {
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
          return folderAt(chain.get(cut < 0 ? '' : path.slice(0, cut))!, path.slice(cut + 1));
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
  async function folderAt(parentId: string, name: string): Promise<string> {
    try {
      return (await repository.createFolder(parentId, name)).id;
    } catch (error) {
      if ((error as Error).message !== DUPLICATE_NAME) throw error;
      const existing = (await repository.listFolder(parentId)).find((n) => n.kind === 'folder' && n.name === name);
      if (!existing) throw error;
      return existing.id;
    }
  }

  /**
   * One transfer, one row. The bar follows what the repository reports — bytes the server has accepted — and the
   * row is only ticked done once the upload resolves, which for a real server means the storage has the file, not
   * merely that filex staged it.
   */
  async function transfer(file: File, parentId: string) {
    const item: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, state: 'running', parentId };
    items.value.push(item);
    await run(item, (options) => files.addUploaded(parentId, { name: file.name, size: file.size, blob: file }, options));
  }

  /**
   * The half every transfer shares: a controller the cancel button can pull, the progress into the row, and the
   * outcome written where the tray reads it. `send` gets the options because a fresh upload and a resumed one
   * differ only in which repository call they make.
   */
  async function run(item: UploadItem, send: (options: Parameters<typeof files.addUploaded>[2]) => Promise<unknown>) {
    const controller = new AbortController();
    running.set(item.id, controller);
    const live = () => items.value.find((i) => i.id === item.id);
    try {
      await send({
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
    } catch {
      // The store's own error banner is for the listing; a failed transfer belongs to its row in the tray.
      const row = live();
      // A cancelled row has already said what it is; a failure must not overwrite that.
      if (row && row.state === 'running') row.state = controller.signal.aborted ? 'cancelled' : 'failed';
      // ⚠ A failed transfer keeps its record: the server is still holding what it accepted, and the next load
      // offers to carry on from there. Only a cancel throws the staged bytes away.
      if (controller.signal.aborted) forget(live()?.sessionId);
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
      const session = await repository.uploadSession(record.id).catch(() => null);
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
   * Closing the tray drops the rows that are over. A transfer still running keeps running, and an interrupted one
   * stays: it is the only place its Resume button lives, and the staged bytes behind it are real.
   */
  function clear() {
    items.value = items.value.filter((i) => i.state === 'running' || i.state === 'interrupted');
  }

  return { items, open, doneCount, failedCount, interruptedCount, start, cancel, resume, discard, restore, clear };
});
