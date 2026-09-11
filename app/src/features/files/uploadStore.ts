import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import { DUPLICATE_NAME, FileLimitExceeded, UploadConflict, UploadRateLimited } from '@/data/repository';
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
 * `queued` is waiting for a slot in the transfer pool, `conflict` is waiting for the person to answer the question
 * in the modal (a name that is taken, or a target somebody else is uploading to right now), and `interrupted` is
 * the one that outlives the page: the server is still holding a staged upload nobody is sending bytes to.
 */
export type UploadState = 'queued' | 'running' | 'conflict' | 'skipped' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** What the modal offers on a row whose name is already taken; the same three the settings offer in advance. */
export type ConflictChoice = Exclude<ConflictBehavior, 'ask'>;
/** Which question a row in `conflict` is asking: the name is taken, or somebody is uploading to it at this moment. */
export type ConflictKind = 'exists' | 'inProgress';
/** The answers a question can take: the three choices, plus Retry for a target that is merely busy. */
export type ConflictAnswer = ConflictChoice | 'retry';

/**
 * How long a row refused as "being uploaded right now" waits before it goes out again. The server holds a target
 * for thirty seconds after its last chunk, so asking again at once would only be refused again.
 */
export const RETRY_DELAY_MS = 5000;

/**
 * How many times a row waits out a full upload window BY ITSELF before it is called a failure.
 *
 * One, because the second refusal is the proof that waiting is not the answer: the server hands back the WHOLE
 * window when the request is larger than the window's entire allowance (backend `quota.checkRate`, whose own
 * comment says no amount of waiting helps), so a 2 GB file under a 1 GB/24 h rule waits a day, is refused again,
 * and waits another — forever, with the batch's promise held open behind it, which means the listing is never
 * re-read and `files.uploadsLanded` never runs. A counted retry covers the honest case (the window really does
 * free up) and stops there; the row keeps the same wording, so sending it again is the person's to decide.
 */
export const MAX_RATE_LIMIT_WAITS = 1;

/**
 * How many transfers may be in flight at once.
 *
 * Every one of them is a staged session on the server, with quota reserved against it and a record in
 * localStorage; a drop of five hundred files used to open five hundred of them at the same instant.
 */
export const MAX_PARALLEL_UPLOADS = 3;

/** Under an hour the wait is said in minutes, above it in hours. Never in seconds: it is an estimate, not a clock. */
const MINUTES_PER_HOUR = 60;

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
  /** Which question the row is asking while it is in `conflict`. */
  conflict?: ConflictKind;
  /**
   * What the server said about THIS row, in the reader's language: the quota refusals, which the generic "Upload
   * failed" cannot explain and which the person can act on (wait, or delete something).
   */
  error?: string;
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
  /** The person chose Replace for this row; it goes out with `ifExists: 'replace'` whatever the settings say. */
  replace?: boolean;
  /**
   * A session with every byte staged whose commit was refused. The next step commits IT rather than uploading
   * again, so a Replace after a commit-time refusal sends no byte twice.
   */
  staged?: string;
  /** How many times this row has already waited out a full upload window on its own. */
  rateWaits?: number;
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

/**
 * How long the server asked us to wait, as a sentence. Rounded UP and never shown in seconds: the number is the
 * server's estimate of when the window frees up, and a countdown would promise a precision it does not have.
 */
function waitLabel(seconds: number, t: (key: string, named: Record<string, unknown>) => string): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes >= MINUTES_PER_HOUR
    ? t('upload.retryInHours', { hours: Math.ceil(minutes / MINUTES_PER_HOUR) })
    : t('upload.retryInMinutes', { minutes });
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
  const answers = new Map<number, (answer: ConflictAnswer, applyToAll: boolean) => void>();
  /** How a row that is waiting on a clock lets its batch carry on: registered by the batch that is holding it. */
  const releases = new Map<number, () => void>();
  /** The row the modal asks about: the first one waiting for an answer. The rest wait their turn. */
  const pendingConflict = computed(() => items.value.find((i) => i.state === 'conflict') ?? null);

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
      const row: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, state: 'queued', parentId };
      items.value.push(row);
      // ⚠ The batch has to hold the row the STORE hands out, not the object that was pushed. `items` is a `ref`,
      // so a push stores the raw object and every read of the array goes through a proxy; writing to the raw one
      // fires no set trap, so nothing that depends on it recomputes. That is how a refused upload stalled: `ask`
      // set `state = 'conflict'` on the raw row, `pendingConflict` never noticed, and the transfer sat in the tray
      // with no question on screen and no way to answer it. (`run` already worked around this by looking the row
      // up again through `items.value` for every progress tick.)
      const item = items.value[items.value.length - 1];
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
      const existing = (await repository.listFolder(parentId)).nodes.find((n) => n.kind === 'folder' && n.name === name);
      if (!existing) throw error;
      return existing.id;
    }
  }

  /**
   * One batch of files, at most `MAX_PARALLEL_UPLOADS` of them in flight.
   *
   * Whether a name is taken is the SERVER's answer, not a listing's: every transfer goes out with `ifExists` and is
   * refused — at `begin`, or at `commit` for a file that appeared meanwhile — when the rule wants to know. The
   * folder is listed at most once per batch, and only to pick a free name for "keep both".
   *
   * A row waiting for an answer, or for the retry delay, holds no slot — it leaves the queue and the answer puts it
   * back — so a batch does not stall behind the first three names the person has not decided about yet.
   *
   * The listing is re-read ONCE, when the last transfer of the batch is over. It used to be re-read by every
   * single file, which for a folder drop meant N listings of the folder, twice as many requests from the details
   * panel behind them, and the Undo record thrown away N times.
   */
  async function runBatch(entries: Entry[], fresh: Set<string>) {
    const queue = [...entries];
    /** Names already in each target folder, listed at most once per folder per batch — only to pick a free name. */
    const listed = new Map<string, Set<string>>();
    /**
     * Names this batch has sent to each folder. Two files of one batch under one name would otherwise collide with
     * each other: the server sees the second only once the first has landed, or as "in progress" while it lands.
     */
    const claimed = new Map<string, Set<string>>();
    /** Rows out of the queue but not over: waiting for an answer, for the retry delay or for a free name. */
    const held = new Set<number>();
    /** "Apply to all": the answer given for the rest of the batch, per question. */
    const forAll: Partial<Record<ConflictKind, ConflictAnswer>> = {};
    const landed: Node[] = [];
    let active = 0;
    let finish!: () => void;
    const over = new Promise<void>((resolve) => (finish = resolve));

    async function taken(parentId: string): Promise<Set<string>> {
      const known = listed.get(parentId);
      if (known) return known;
      const names = fresh.has(parentId)
        ? new Set<string>()
        // The open folder's listing is already in memory, when it is the whole folder; a second copy of it is a
        // request for nothing.
        : files.folder?.id === parentId && files.items.length === files.total
          ? new Set(files.items.map((n) => n.name))
          : new Set((await repository.listFolder(parentId)).nodes.map((n) => n.name));
      listed.set(parentId, names);
      return names;
    }

    function claimedIn(parentId: string): Set<string> {
      let names = claimed.get(parentId);
      if (!names) claimed.set(parentId, (names = new Set()));
      return names;
    }

    /**
     * A row that is out of the queue but not over. It keeps the batch's promise pending, so a row cancelled while
     * it is merely WAITING on a clock — a full window, a busy target — has to let go of the hold itself: without
     * that, the batch stayed open for the whole wait and neither the listing refresh nor `uploadsLanded` ran.
     */
    function hold(id: number) {
      held.add(id);
      releases.set(id, () => {
        unhold(id);
        pump();
      });
    }

    function unhold(id: number) {
      held.delete(id);
      releases.delete(id);
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
      if (!active && !queue.length && !held.size) finish();
    }

    async function step(entry: Entry) {
      // Cancelled while it waited for a slot: the row has already said what it is.
      if (entry.item.state !== 'queued') return;
      const rule: ConflictBehavior = entry.replace ? 'replace' : settings.settings.conflictBehavior;
      const names = claimedIn(entry.parentId);
      // A staged row already owns its name; anything else that claimed it meanwhile is the server's to refuse.
      if (rule !== 'replace' && !entry.staged && names.has(entry.item.name)) {
        return conflict(entry, rule, new UploadConflict('exists', 'begin', null));
      }
      // Whoever claimed the name owns the claim: a `replace` rule and a staged row both walk past the guard above
      // with somebody else's claim standing, and releasing it below would let a third row of the same name through.
      const claimedName = entry.item.name;
      const ownsClaim = !names.has(claimedName);
      names.add(claimedName);
      entry.item.state = 'running';
      const ifExists = rule === 'replace' ? 'replace' : 'fail';
      try {
        const node = await run(entry.item, (options) =>
          entry.staged
            ? repository.commitUpload(entry.staged, entry.parentId, entry.item.name, { ...options, ifExists })
            : files.addUploaded(entry.parentId, { name: entry.item.name, size: entry.file.size, blob: entry.file }, { ...options, ifExists }),
        );
        if (node) landed.push(node);
      } catch (error) {
        // `run` reports every other failure into the row itself; the two it hands back are the ones a BATCH has to
        // answer for: a refused target, and a window that is full and will free up on its own.
        if (ownsClaim) names.delete(claimedName);
        if (error instanceof UploadRateLimited) return waitOut(entry, error.retryAfterSeconds);
        if (!(error instanceof UploadConflict)) throw error;
        conflict(entry, rule, error);
      }
    }

    /**
     * The account has uploaded its allowance for the current window. Nothing about this row is wrong and nobody has
     * a decision to make, so it is not a question and not a failure: the row says how long the server asked for and
     * goes out again by itself when that is up.
     *
     * Once, though — see `MAX_RATE_LIMIT_WAITS`. A second refusal means the window is not what stands in the way,
     * and the row fails with the same sentence rather than waiting again behind a batch that can never settle.
     */
    function waitOut(entry: Entry, seconds: number) {
      const said = t('upload.rateLimited', { wait: waitLabel(seconds, t) });
      entry.rateWaits = (entry.rateWaits ?? 0) + 1;
      if (entry.rateWaits > MAX_RATE_LIMIT_WAITS) {
        entry.item.state = 'failed';
        entry.item.progress = 0;
        entry.item.error = said;
        return;
      }
      entry.item.state = 'queued';
      entry.item.progress = 0;
      entry.item.error = said;
      hold(entry.item.id);
      setTimeout(() => {
        unhold(entry.item.id);
        // Cancelled while it waited: the row has already said what it is.
        if (entry.item.state === 'queued') {
          entry.item.error = undefined;
          queue.push(entry);
        }
        pump();
      }, Math.max(0, seconds) * 1000);
    }

    /**
     * The server refused the target. The rule answers on its own where it can; "ask" — and a busy target under
     * "replace", for which the settings have no answer — becomes the question in the modal.
     */
    function conflict(entry: Entry, rule: ConflictBehavior, refusal: UploadConflict) {
      // A refusal at commit leaves every byte staged: the session is kept, to be committed or dropped by the answer.
      if (refusal.phase === 'commit' && refusal.sessionId) entry.staged = refusal.sessionId;
      if (refusal.reason === 'exists') {
        // `replace` is never refused for a taken name; were it ever, asking is the honest answer.
        const answer = rule === 'ask' ? forAll.exists : rule === 'replace' ? undefined : rule;
        return answer ? apply(entry, answer) : ask(entry, 'exists');
      }
      const answer = rule === 'skip' || rule === 'keepBoth' ? rule : forAll.inProgress;
      return answer ? apply(entry, answer) : ask(entry, 'inProgress');
    }

    /** Puts the question in front of the person and steps out of the way until it is answered. */
    function ask(entry: Entry, kind: ConflictKind) {
      entry.item.state = 'conflict';
      entry.item.conflict = kind;
      // Through `hold` and not `held.add`, for the same reason a clock-bound wait does: the question is drawn from
      // `pendingConflict`, which looks for state 'conflict', so cancelling this row takes the modal off the screen
      // and no answer is ever coming. Without a release registered, the batch's promise would stay pending for the
      // rest of the session and the listing would never hear that the uploads finished.
      hold(entry.item.id);
      answers.set(entry.item.id, (answer, applyToAll) => {
        answers.delete(entry.item.id);
        unhold(entry.item.id);
        if (applyToAll) {
          forAll[kind] = answer;
          // Rows of this batch already waiting with the same question take the answer too: with three transfers
          // in flight, the second and third refusals are usually in by the time the first is answered.
          for (const other of entries) {
            if (other.item.state === 'conflict' && other.item.conflict === kind) answers.get(other.item.id)?.(answer, false);
          }
        }
        apply(entry, answer);
        pump();
      });
    }

    /** Acts on an answer — the rule's or the person's — and puts the row back on its way, or lets it go. */
    function apply(entry: Entry, answer: ConflictAnswer) {
      switch (answer) {
        case 'skip':
          entry.item.state = 'skipped';
          void release(entry);
          return;
        case 'keepBoth':
          entry.item.state = 'queued';
          void rename(entry);
          return;
        case 'replace':
          entry.replace = true;
          requeue(entry);
          return;
        case 'retry':
          entry.item.state = 'queued';
          hold(entry.item.id);
          setTimeout(() => {
            unhold(entry.item.id);
            // Cancelled while it waited: the row has already said what it is.
            if (entry.item.state === 'queued') queue.unshift(entry);
            pump();
          }, RETRY_DELAY_MS);
      }
    }

    /** An answered row goes first: the person is waiting on that one. */
    function requeue(entry: Entry) {
      entry.item.state = 'queued';
      queue.unshift(entry);
      pump();
    }

    /** A row that will not land under its staged session: whatever the server holds for it goes too. */
    async function release(entry: Entry) {
      const session = entry.staged;
      entry.staged = undefined;
      await drop(session);
    }

    /**
     * "Keep both": a name the folder does not have, then out again. A staged session is bound to the refused name,
     * so it is dropped and the bytes travel once more under the new one.
     */
    async function rename(entry: Entry) {
      held.add(entry.item.id);
      try {
        await release(entry);
        const names = await taken(entry.parentId);
        // The server refused this name whatever the listing said — taken since it was read, or by this batch.
        names.add(entry.item.name);
        entry.item.name = freeName(entry.item.name, new Set([...names, ...claimedIn(entry.parentId)]));
        entry.item.progress = 0;
        if (entry.item.state === 'queued') queue.unshift(entry);
      } catch {
        // The folder could not be listed, so no name can be promised free; the row says so as a failed transfer.
        entry.item.state = 'failed';
      } finally {
        held.delete(entry.item.id);
        pump();
      }
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

  /**
   * The person's answer to the question a row in `conflict` is asking; ignored for a row that is not asking.
   * `applyToAll` gives the same answer to every later question of that kind in the row's batch.
   */
  function decide(id: number, answer: ConflictAnswer, options: { applyToAll?: boolean } = {}) {
    // A row that is no longer asking has nothing to answer: cancel already released it, and re-entering the
    // conflict path would put a cancelled transfer back in the queue.
    if (items.value.find((i) => i.id === id)?.state !== 'conflict') return;
    answers.get(id)?.(answer, options.applyToAll ?? false);
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
    } catch (error) {
      // A refused target is not a failure: the caller decides — or asks — what happens to the row next. Neither is
      // a full upload window, which the batch re-queues rather than reporting.
      if (error instanceof UploadConflict || error instanceof UploadRateLimited) throw error;
      // The account may hold no more files. That IS a failure — waiting will not fix it — and the row says which
      // ceiling it met, because "Upload failed" sends the person looking for a network problem.
      if (error instanceof FileLimitExceeded) {
        const stopped = live();
        if (stopped && stopped.state === 'running') {
          stopped.state = 'failed';
          stopped.error = t('upload.fileLimit', { limit: error.limit.toLocaleString() });
        }
        return undefined;
      }
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
    // A row waiting on a clock rather than on the network holds its batch open; the state above is what the timer
    // reads, and this is what lets the batch settle now instead of when the wait is up.
    releases.get(id)?.();
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
    try {
      await run(row, (options) => files.addResumed(session, row.parentId, { name: file.name, size: file.size, blob: file }, options));
    } catch (error) {
      // No batch stands behind a resumed row to answer for it: a target somebody else is writing to right now — or
      // a full upload window — is reported like a failed transfer, and the record stays for the next start to offer
      // again.
      if (error instanceof UploadRateLimited) row.error = t('upload.rateLimited', { wait: waitLabel(error.retryAfterSeconds, t) });
      else if (!(error instanceof UploadConflict)) throw error;
      row.state = 'failed';
    }
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

  return { items, open, doneCount, failedCount, interruptedCount, pendingCount, pendingConflict, start, cancel, decide, resume, discard, restore, clear };
});
