import { fileTypeOf, TYPE_THUMBNAILS } from '../fileTypes';
import type { Node, Quota, Storage } from '../types';

/**
 * filex's wire shapes → the app's model, and the addressing that ties them together.
 *
 * filex speaks two dialects on the same API. Folder listings, search and every mutation address nodes by
 * `<storage name>://<path>` and answer with the `FileNode` projection; the per-user metadata endpoints (starred,
 * recent, tagged) and `/stat` address them by a numeric node id and answer with a raw `model.Node`. The app takes
 * the path as its identity — it is what the router already carries and what survives a reload — and the repository
 * keeps the numeric ids beside it for the endpoints that insist on them.
 */

/** `<adapter>://<rel>`; an empty `rel` is the storage root and stays as the bare `<adapter>://`. */
export function joinPath(adapter: string, rel: string): string {
  return `${adapter}://${rel.replace(/^\/+|\/+$/g, '')}`;
}

export function splitPath(id: string): { adapter: string; rel: string } {
  const at = id.indexOf('://');
  if (at < 0) return { adapter: '', rel: id.replace(/^\/+|\/+$/g, '') };
  return { adapter: id.slice(0, at), rel: id.slice(at + 3).replace(/^\/+|\/+$/g, '') };
}

/** The folder holding `id`, or null when `id` is a storage root (which has no parent). */
export function parentPath(id: string): string | null {
  const { adapter, rel } = splitPath(id);
  if (!rel) return null;
  return joinPath(adapter, rel.slice(0, rel.lastIndexOf('/') + 1));
}

export function nameOf(id: string): string {
  const { rel } = splitPath(id);
  return rel.slice(rel.lastIndexOf('/') + 1);
}

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
  thumb_url?: string;
  /** The caller's effective level here — "" when the storage has RBAC off. */
  perm?: string;
  etag?: string;
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
}

/** One row of `/api/files/manager/trash` — `trash.TrashEntry`, a projection of its own. */
export interface WireTrashEntry {
  id: number;
  storage_id: number;
  storage_name?: string;
  /** The path the node had before it was trashed. */
  path: string;
  name: string;
  size: number;
  mime?: string;
  deleted_at: string;
  ttl_days?: number;
}

/** One row of `/api/files/storages`. */
export interface WireStorage {
  name: string;
  read_only: boolean;
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

/** The parts every mapper fills the same way, from a name and a kind. */
function typed(name: string, kind: Node['kind']): Pick<Node, 'fileType' | 'thumbnail' | 'ownerId'> {
  const fileType = kind === 'file' ? fileTypeOf(name) : undefined;
  return { fileType, thumbnail: fileType ? TYPE_THUMBNAILS[fileType] : undefined, ownerId: SELF };
}

/**
 * A listing row. `shared` and `starred` are false here on purpose: both are separate calls (`/share`,
 * `/manager/star/list`), and the repository folds their answers in — a row cannot know on its own.
 */
export function fromFileNode(wire: WireFileNode): Node {
  const kind = wire.type === 'dir' ? 'folder' : 'file';
  return {
    id: wire.path,
    name: wire.basename,
    kind,
    parentId: parentPath(wire.path),
    size: kind === 'folder' ? 0 : wire.size,
    // A row with no date at all would sort as "Invalid Date"; the epoch sorts last and reads as "unknown".
    modifiedAt: new Date(wire.last_modified ?? 0).toISOString(),
    ...typed(wire.basename, kind),
    assetUrl: kind === 'file' ? previewUrl(wire.path) : undefined,
    shared: false,
    starred: false,
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
  return {
    id,
    name: wire.name,
    kind,
    parentId: parentPath(id),
    size: kind === 'folder' ? 0 : wire.size,
    modifiedAt: wire.backend_mtime ?? wire.db_mtime ?? wire.updated_at ?? new Date(0).toISOString(),
    // Unlike the listing projection, `model.Node` does carry it — the details panel shows it when it is there.
    createdAt: wire.created_at,
    ...typed(wire.name, kind),
    assetUrl: kind === 'file' ? previewUrl(id) : undefined,
    shared: false,
    starred: false,
    ...(wire.deleted_at ? { deletedAt: wire.deleted_at } : {}),
  };
}

/**
 * A trashed node. The projection carries neither a type nor a modification date — only where the node used to be
 * and when it was deleted — so a trashed row is a file unless its old path says otherwise, and its "modified"
 * column shows the deletion instant, which is what the trash listing sorts by anyway.
 */
export function fromTrashEntry(wire: WireTrashEntry): Node {
  const adapter = wire.storage_name ?? '';
  const id = joinPath(adapter, wire.path);
  const parent = parentPath(id);
  return {
    id,
    name: wire.name,
    kind: 'file',
    parentId: parent,
    size: wire.size,
    modifiedAt: wire.deleted_at,
    ...typed(wire.name, 'file'),
    shared: false,
    starred: false,
    deletedAt: wire.deleted_at,
    originalPath: parent ? `/${splitPath(parent).rel}` : '/',
  };
}

/**
 * A drive. Its id is its name — the same token that addresses every node inside it — and its root is the bare
 * `<name>://`, which is exactly what the listing endpoint reads as "the top of this storage".
 *
 * The quota is the ACCOUNT's, not the drive's: filex meters per user, so every drive reports the same figure.
 */
export function toStorage(wire: WireStorage, quota: Quota): Storage {
  return { id: wire.name, name: wire.name, rootId: joinPath(wire.name, ''), quota };
}

/** An unlimited account is shown as an empty ceiling rather than a bar that can never fill. */
export function toQuota(wire: WireQuota): Quota {
  return { usedBytes: wire.used_bytes, totalBytes: wire.unlimited ? 0 : wire.quota_bytes };
}
