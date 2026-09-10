import { joinPath, parentPath, splitPath } from '@/lib/address';
import { fileTypeOf, TYPE_THUMBNAILS } from '../fileTypes';
import type { ActivityEvent, FileType, MatchRange, Node, Quota, SearchHit, Session, Storage } from '../types';

/**
 * filex's wire shapes → the app's model, and the addressing that ties them together.
 *
 * filex speaks two dialects on the same API. Folder listings, search and every mutation address nodes by
 * `<storage name>://<path>` and answer with the `FileNode` projection; the per-user metadata endpoints (starred,
 * recent, tagged) and `/stat` address them by a numeric node id and answer with a raw `model.Node`. The app takes
 * the path as its identity — it is what the router already carries and what survives a reload — and the repository
 * keeps the numeric ids beside it for the endpoints that insist on them.
 */

// Addressing itself lives in `@/lib/address`: which drive a node is on and what holds it is domain knowledge,
// not a property of this transport.

/** `model.Node.type` and the `FileNode` projection of it. A symlink is listed as the file it stands for. */
type WireType = 'file' | 'dir' | 'symlink';

/** One row of a folder listing, a search result or `?q=subfolders` — `projectFileNodes` in the backend. */
export interface WireFileNode {
  id: number;
  /** Already adapter-qualified: `main://Docs/report.pdf`. */
  path: string;
  basename: string;
  type: WireType;
  extension: string;
  size: number;
  mime_type?: string;
  storage: string;
  /** Epoch milliseconds; the driver's mtime, or when filex first saw the node. */
  last_modified?: number;
  /** `/api/files/thumb/{id}`, present only once the pipeline has a ready thumbnail. */
  thumb_url?: string;
  /** The caller's effective level here — "" when the storage has RBAC off. */
  perm?: string;
  etag?: string;
  /** Who owns the node, named. Absent for anything a storage sync found rather than a person uploading it. */
  owner_id?: number;
  owner_name?: string;
  /** Epoch milliseconds; when filex first saw the node. */
  created_at?: number;
  /** True while a public link to this node still opens. */
  shared?: boolean;
  /** Entries in a folder, counted the way this listing counts them. Absent when the server did not count. */
  item_count?: number;
  /** `shared-with-me` only: when the grant was made, epoch milliseconds. */
  shared_at?: number;
  /** `shared-with-me` only: the account that issued the grant, and its display name when it has one. */
  shared_by?: number;
  shared_by_name?: string;
}

/** The `?q=index` envelope. `storages` is the caller's visible drive list, already RBAC-filtered. */
export interface WireIndex {
  adapter: string;
  storages: string[];
  dirname: string;
  read_only: boolean;
  perm?: string;
  files: WireFileNode[];
}

/** `model.Node` — what `/stat` and the per-user metadata listings answer with. */
export interface WireNode {
  id: number;
  storage_id: number;
  name: string;
  path: string;
  type: WireType;
  size: number;
  mime?: string;
  backend_mtime?: string | null;
  db_mtime?: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  /** Storage NAME, filled in by the handlers that return rows from outside a folder listing. */
  storage?: string;
  /** True while a public link to this node still opens. */
  shared?: boolean;
  /** Who put the file there. Absent on anything a storage sync found rather than a person uploading it. */
  owner_id?: number;
  /** The display name behind `owner_id`, stamped per listing page — an owner column showing a number is unreadable. */
  owner_name?: string;
  /** Thumbnail state, stamped by the handlers that list files outside a folder; only `ready` has bytes to serve. */
  thumb?: { state: 'pending' | 'ready' | 'failed' | 'skipped' };
  /** `/manager/recent` only: when THIS caller last opened the node, RFC3339. The listing's own sort key. */
  opened_at?: string;
}

/** One row of `/api/files/manager/trash` — `trash.TrashEntry`, a projection of its own. */
export interface WireTrashEntry {
  id: number;
  storage_id: number;
  storage_name?: string;
  /** The path the node had before it was trashed. */
  path: string;
  name: string;
  /** The node's kind, spelled as everywhere else. Absent on a server too old to send it. */
  type?: WireType;
  size: number;
  mime?: string;
  deleted_at: string;
  ttl_days?: number;
}

/** One row of `/api/files/storages`. */
/** A row of filex's ops queue (`internal/ops.Op`); only the fields the app polls for are named. */
/** One row of `GET /api/files/activity`: filex's own event name, plus the payload that tells a rename from a move. */
export interface WireActivityEvent {
  id: number;
  event: string;
  at: string;
  actor_id?: number;
  actor_name?: string;
  meta?: Record<string, unknown>;
}

/**
 * filex's file events, in the app's vocabulary. Only the events that ARE something happening to a file are mapped:
 * `comment.added`, `file.infected` and `file.upload_failed` are about other surfaces, and `file.deleted` — the hard
 * delete a driver without move support falls back to — is dropped because the node it names is gone, so nothing can
 * open a panel on it.
 *
 * `file.moved` is two of the app's kinds at once: filex records one event with `from` and `to`, and which one it is
 * depends on whether the folder changed. Renaming and moving are the same operation to a storage driver and two
 * different sentences to a person.
 */
export function fromActivityEvent(wire: WireActivityEvent, storageName: string): ActivityEvent | null {
  const from = typeof wire.meta?.from === 'string' ? wire.meta.from : '';
  const to = typeof wire.meta?.to === 'string' ? wire.meta.to : '';
  const renamed = Boolean(from && to) && dirOf(from) === dirOf(to);
  const kind = renamed ? 'renamed' : ACTIVITY_KINDS[wire.event];
  if (!kind) return null;
  return {
    id: String(wire.id),
    at: wire.at,
    actorId: wire.actor_id === undefined ? '' : String(wire.actor_id),
    actorName: wire.actor_name ?? '',
    kind,
    detail: detailFor(kind, from, to, storageName),
  };
}

const ACTIVITY_KINDS: Record<string, ActivityEvent['kind'] | undefined> = {
  'file.uploaded': 'created',
  'file.updated': 'modified',
  'file.moved': 'moved',
  'file.trashed': 'trashed',
  'share.created': 'linkShared',
};

/** The one variable part each sentence takes: the name it had, or the folder it went to. */
function detailFor(kind: ActivityEvent['kind'], from: string, to: string, storageName: string): string | undefined {
  if (kind === 'renamed') return baseOf(from);
  if (kind === 'moved') {
    const folder = baseOf(dirOf(to));
    // A move to the top of a drive has no folder above it to name; the drive is what the user sees there.
    return folder || storageName;
  }
  return undefined;
}

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** What `POST /manager/trash/empty` answers: how much it took, and whether a round is left to ask for. */
export interface WireTrashEmpty {
  purged: number;
  failed: number;
  skipped: number;
  more: boolean;
}

export interface WireOp {
  id: number;
  kind: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'partial';
  error?: string;
}

/**
 * The staged upload's three answers. filex sends every id and size in both snake_case and camelCase (docs/UPLOADS.md),
 * so both spellings are optional and the reader takes whichever came.
 */
export interface WireUploadBegin {
  id: string;
  chunk_size?: number;
  chunkSize?: number;
  /** Bytes the server already holds: 0 for a fresh session. */
  offset?: number;
}

/** `GET /api/files/upload/{id}` — how far a staged upload got, and whether it is still open. */
export interface WireUploadStatus {
  offset?: number;
  total_size?: number;
  totalSize?: number;
  chunk_size?: number;
  chunkSize?: number;
  /** "staging" while it can still be continued; anything else means it is over. */
  state?: string;
}

export interface WireUploadPut {
  /** Authoritative resume point — a refused chunk leaves it where it was. */
  offset?: number;
}

export interface WireUploadCommit {
  op_id?: number;
  opId?: number;
}

/** `GET /api/auth/methods` — a name and two flags, never any provider configuration. */
export interface WireAuthMethods {
  provider: string;
  change_password: boolean;
  totp_enabled: boolean;
}

/** `sessionView` from `GET /api/auth/sessions`. The session token is never in the answer. */
export interface WireSession {
  id: number;
  ip?: string;
  user_agent?: string;
  created_at: string;
  expires_at: string;
  current: boolean;
}

export function fromSession(wire: WireSession): Session {
  return {
    id: String(wire.id),
    ip: wire.ip,
    userAgent: wire.user_agent,
    createdAt: wire.created_at,
    expiresAt: wire.expires_at,
    current: wire.current,
  };
}

export interface WireStorage {
  name: string;
  read_only: boolean;
  /** What THIS drive holds. The quota endpoint beside it meters the account, which is a different number. */
  used_bytes?: number;
  /** The caller reaches this drive through grants rather than through their role — a shared drive. */
  shared?: boolean;
}

/** `quota.Snapshot` from `/api/files/quota/me`; `unlimited` means the account has no ceiling. */
export interface WireQuota {
  used_bytes: number;
  quota_bytes: number;
  unlimited?: boolean;
}

/** The id every node belongs to: filex has no per-node owner, so everything the user can see is theirs. */
export const SELF = 'me';

/** A file's bytes, inline. Served by the same manager endpoint the listing came from, so it needs no node id. */
export function previewUrl(id: string): string {
  return `/api/files/manager?q=preview&path=${encodeURIComponent(id)}`;
}

/** A file's bytes as a download (Content-Disposition: attachment). */
export function downloadUrl(id: string): string {
  return `/api/files/manager?q=download&path=${encodeURIComponent(id)}`;
}

/**
 * Below this an image is its own tile: the server renders no thumbnail for it (the same number is
 * `thumb.SmallImageBytes` in Go; the two move together), so the file is what the grid shows.
 */
export const SMALL_IMAGE_BYTES = 500 * 1024;

/**
 * The types whose server thumbnail is a picture OF the file: a downscaled image, a PDF's first page, a video frame.
 * For a type filex has no generator for it draws a coloured card with the extension on it (`thumb/generic.go`)
 * instead, which the app's own placeholder art already covers, better; that card is not shown. A type it CAN render
 * but has no tool for sends no thumbnail at all (state `skipped`), so the art shows there too.
 */
const RENDERED_TYPES: ReadonlySet<FileType> = new Set<FileType>(['image', 'pdf', 'mp4']);

/**
 * What a file's tile paints: the cached thumbnail when the server rendered one, versioned by the file's mtime; a small
 * image's own bytes; nothing else, so the placeholder art shows. The version is belt-and-braces now that the thumb
 * endpoint revalidates (ETag + `no-cache`), and it keeps the URL of an overwritten file distinct in any proxy between.
 */
function tileUrl(
  thumb: string | undefined,
  version: string | number | undefined,
  file: { fileType?: FileType; size: number; original: string },
): string | undefined {
  if (thumb !== undefined && file.fileType !== undefined && RENDERED_TYPES.has(file.fileType)) {
    return version === undefined ? thumb : `${thumb}?v=${encodeURIComponent(String(version))}`;
  }
  return file.fileType === 'image' && file.size > 0 && file.size < SMALL_IMAGE_BYTES ? file.original : undefined;
}

/** The parts every mapper fills the same way, from a name and a kind. */
function typed(name: string, kind: Node['kind']): Pick<Node, 'fileType' | 'thumbnail' | 'ownerId'> {
  const fileType = kind === 'file' ? fileTypeOf(name) : undefined;
  return { fileType, thumbnail: fileType ? TYPE_THUMBNAILS[fileType] : undefined, ownerId: SELF };
}

/**
 * A listing row. `starred` is false here on purpose: it is a separate call (`/manager/star/list`) and the
 * repository folds the answer in. `shared` the row does carry — the listing counts the live public links for
 * its whole page in one query, so a badge no longer means "open the share modal and find out".
 */
export function fromFileNode(wire: WireFileNode): Node {
  const kind = wire.type === 'dir' ? 'folder' : 'file';
  const parts = typed(wire.basename, kind);
  const thumbUrl =
    kind === 'file' ? tileUrl(wire.thumb_url, wire.last_modified, { ...parts, size: wire.size, original: previewUrl(wire.path) }) : undefined;
  return {
    id: wire.path,
    name: wire.basename,
    kind,
    parentId: parentPath(wire.path),
    size: kind === 'folder' ? 0 : wire.size,
    // A row filex could not date at all keeps none, rather than being stamped with the epoch.
    modifiedAt: wire.last_modified === undefined ? undefined : new Date(wire.last_modified).toISOString(),
    // A row filex could not date at all keeps none here too.
    createdAt: wire.created_at === undefined ? undefined : new Date(wire.created_at).toISOString(),
    ...parts,
    assetUrl: kind === 'file' ? previewUrl(wire.path) : undefined,
    ...(thumbUrl === undefined ? {} : { thumbUrl }),
    shared: wire.shared ?? false,
    ...(wire.item_count === undefined ? {} : { itemCount: wire.item_count }),
    starred: false,
    // `typed` fills ownerId with SELF; a row filex could name an owner for overrides that with the real one.
    ...(wire.owner_id === undefined ? {} : { ownerId: String(wire.owner_id), ownerName: wire.owner_name }),
  };
}

/**
 * A `model.Node` row. These come from the metadata listings, which carry the storage NAME alongside the numeric
 * id precisely so a client can rebuild the address; a row without one cannot be opened and is dropped by the
 * repository rather than mapped to a broken id.
 */
export function fromModelNode(wire: WireNode, adapter: string): Node {
  const kind = wire.type === 'dir' ? 'folder' : 'file';
  const id = joinPath(adapter, wire.path);
  const modifiedAt = wire.backend_mtime ?? wire.db_mtime ?? wire.updated_at;
  const parts = typed(wire.name, kind);
  const thumbUrl =
    kind === 'file'
      ? tileUrl(wire.thumb?.state === 'ready' ? `/api/files/thumb/${wire.id}` : undefined, modifiedAt, {
          ...parts,
          size: wire.size,
          original: previewUrl(id),
        })
      : undefined;
  return {
    id,
    name: wire.name,
    kind,
    parentId: parentPath(id),
    size: kind === 'folder' ? 0 : wire.size,
    modifiedAt,
    // Unlike the listing projection, `model.Node` does carry it — the details panel shows it when it is there.
    createdAt: wire.created_at,
    ...parts,
    assetUrl: kind === 'file' ? previewUrl(id) : undefined,
    ...(thumbUrl === undefined ? {} : { thumbUrl }),
    shared: wire.shared ?? false,
    starred: false,
    // Recent orders and groups by this; without it the page fell back to the mtime and "Today" meant "written today".
    ...(wire.opened_at ? { openedAt: wire.opened_at } : {}),
    ...(wire.deleted_at ? { deletedAt: wire.deleted_at } : {}),
    // `typed` fills ownerId with SELF; a row filex could name an owner for overrides that with the real one.
    ...(wire.owner_id === undefined ? {} : { ownerId: String(wire.owner_id), ownerName: wire.owner_name }),
  };
}

/**
 * One row the assistant's search found, as the tool reports it: an address, the
 * basics of the file, and — for a content hit — a snippet with the matched
 * words wrapped in « ».
 *
 * ⚠ Its own shape, not `WireNode`. The assistant's file surface answers in the
 * addressing scheme (`drive://path`, unix millis) rather than in node rows, and
 * faking a `WireNode` here would mean inventing a numeric id that means nothing.
 */
export interface WireAssistantHit {
  path: string;
  name: string;
  type: WireType;
  size?: number;
  mime?: string;
  last_modified?: number;
  snippet?: string;
  matched?: string;
}

/** Splits a server snippet on its « » markers into text plus highlight ranges. */
export function fromSnippet(raw: string): { text: string; ranges: MatchRange[] } {
  const ranges: MatchRange[] = [];
  let text = '';
  let rest = raw;
  for (;;) {
    const open = rest.indexOf('«');
    const close = open < 0 ? -1 : rest.indexOf('»', open + 1);
    if (open < 0 || close < 0) break;
    text += rest.slice(0, open);
    const start = text.length;
    text += rest.slice(open + 1, close);
    ranges.push({ start, end: text.length });
    rest = rest.slice(close + 1);
  }
  return { text: text + rest, ranges };
}

/** One assistant search result, as the panel's result card reads it. */
export function fromAssistantHit(wire: WireAssistantHit): SearchHit {
  const kind = wire.type === 'dir' ? 'folder' : 'file';
  const { adapter } = splitPath(wire.path);
  const parent = parentPath(wire.path);
  const node: Node = {
    id: wire.path,
    name: wire.name,
    kind,
    parentId: parent,
    size: kind === 'folder' ? 0 : (wire.size ?? 0),
    modifiedAt: wire.last_modified ? new Date(wire.last_modified).toISOString() : undefined,
    ...typed(wire.name, kind),
    assetUrl: kind === 'file' ? previewUrl(wire.path) : undefined,
    shared: false,
    starred: false,
  };
  return {
    node,
    storageId: adapter,
    folderPath: parent ? splitPath(parent).rel : '',
    ...(wire.snippet ? { snippet: fromSnippet(wire.snippet) } : {}),
  };
}

/**
 * A trashed node. The projection carries no modification date — only where the node used to be and when it was
 * deleted — so its "modified" column shows the deletion instant, which is what the trash listing sorts by anyway.
 *
 * The kind comes off the row: a deleted FOLDER used to arrive as a file, so it got an icon picked by extension and
 * a byte count where a folder shows a dash. A server too old to send one still says "file", which is what every
 * such row was before.
 */
export function fromTrashEntry(wire: WireTrashEntry): Node {
  const adapter = wire.storage_name ?? '';
  const id = joinPath(adapter, wire.path);
  const parent = parentPath(id);
  const kind = wire.type === 'dir' ? 'folder' : 'file';
  return {
    id,
    name: wire.name,
    kind,
    parentId: parent,
    size: kind === 'folder' ? 0 : wire.size,
    modifiedAt: wire.deleted_at,
    ...typed(wire.name, kind),
    shared: false,
    starred: false,
    deletedAt: wire.deleted_at,
    // What the banner and the purge countdown say. Absent on a server that does not count it down.
    ...(wire.ttl_days === undefined ? {} : { ttlDays: wire.ttl_days }),
    originalPath: parent ? `/${splitPath(parent).rel}` : '/',
  };
}

/**
 * A drive. Its id is its name — the same token that addresses every node inside it — and its root is the bare
 * `<name>://`, which is exactly what the listing endpoint reads as "the top of this storage".
 *
 * The quota is the ACCOUNT's, not the drive's: filex meters per user, so two drives draw two bars against the
 * same ceiling, each showing the share of it that drive takes.
 */
export function toStorage(wire: WireStorage, limitBytes: number): Storage {
  return {
    id: wire.name,
    name: wire.name,
    rootId: joinPath(wire.name, ''),
    quota: { usedBytes: wire.used_bytes ?? 0, totalBytes: limitBytes },
    shared: wire.shared ?? false,
  };
}

/** An unlimited account is shown as an empty ceiling rather than a bar that can never fill. */
export function toQuota(wire: WireQuota): Quota {
  return { usedBytes: wire.used_bytes, totalBytes: wire.unlimited ? 0 : wire.quota_bytes };
}
