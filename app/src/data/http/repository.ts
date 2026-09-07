import { DUPLICATE_NAME, type Repository } from '../repository';
import { matchesFilter } from '../listingFilter';
import { noCapabilities, type ActivityEvent, type AssistantEvent, type Capabilities, type ListingFilter, type Node, type Person, type Quota, type SearchHit, type SearchQuery, type SearchResult, type Storage, type UploadInput, type User, type Version } from '../types';
import { HttpError, request, upload } from './client';
import {
  fromFileNode,
  fromModelNode,
  fromTrashEntry,
  joinPath,
  nameOf,
  parentPath,
  splitPath,
  toQuota,
  toStorage,
  type WireFileNode,
  type WireIndex,
  type WireNode,
  type WireQuota,
  type WireStorage,
  type WireTrashEntry,
} from './map';

/**
 * The repository against a live filex server.
 *
 * Addressing is the hybrid described in docs/BACKEND-GAP.md: a node's identity is its `<storage>://<path>`, which is
 * what the listing and mutation endpoints speak and what the router already carries, while the per-user metadata
 * endpoints (star, tags, recent, versions, permissions) insist on the numeric node id. Every listing answer carries
 * both, so this class remembers the numeric one beside the path and hands it over where it is required.
 *
 * A node the app has never listed therefore has no numeric id here — which is also true of the user, who cannot
 * star or tag something they have not seen. `nodeId` says so plainly rather than sending a request that would 400.
 */

const MANAGER = '/api/files/manager';

/** How many rows the metadata listings return; filex caps starred at 500 and recent at 200. */
const STARRED_LIMIT = 500;
const RECENT_LIMIT = 200;
const TRASH_LIMIT = 500;
const SEARCH_LIMIT = 100;

/** filex answers a name collision with 409 on every write verb; the modals expect the shared error. */
function asRepositoryError(error: unknown): never {
  if (error instanceof HttpError && error.status === 409) throw new Error(DUPLICATE_NAME);
  throw error;
}

/** `acl.Level` ↔ the roles the access modal offers. filex has no fourth level, so the mapping is total. */
const LEVELS: Record<string, Person['role']> = { owner: 'owner', editor: 'editor', viewer: 'viewer' };

interface WireGrant {
  id: number;
  user_id: number;
  level: string;
  user_email?: string;
  user_display_name?: string;
  inherited?: boolean;
}

interface WireUser {
  id: number;
  email: string;
  display_name?: string;
  role: string;
}

interface WireVersion {
  id: number;
  node_id: number;
  version_n: number;
  size: number;
  created_at: string;
}

/** `model.Capabilities` — only the fields the app gates on. */
interface WireCapabilities {
  upload?: boolean;
  move?: boolean;
  copy?: boolean;
  delete?: boolean;
  mkdir?: boolean;
  search?: boolean;
  versions?: boolean;
  ocr?: boolean;
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** The address a new child of `parentId` will have. Every write verb answers with a listing, not a row, so the
 *  repository has to know where to look for what it just made. */
function childPath(parentId: string, name: string): string {
  const { adapter, rel } = splitPath(parentId);
  return joinPath(adapter, rel ? `${rel}/${name}` : name);
}

export class HttpRepository implements Repository {
  /** `<storage>://<path>` → the numeric node id filex knows it by. Filled by every listing that mentions the node. */
  private readonly ids = new Map<string, number>();
  /** `<node path>|<person id>` → the grant row's id, which is what PATCH and DELETE address. */
  private readonly grants = new Map<string, number>();
  private storages: Storage[] | null = null;
  private user: User | null = null;

  private remember(path: string, id: number): void {
    this.ids.set(path, id);
  }

  /**
   * The numeric id of a node this session has listed. Throwing beats sending `node_id=NaN`: the caller is asking
   * for something only a listed node can have, so a miss is a bug in the caller, not a server condition.
   */
  private nodeId(path: string): number {
    const id = this.ids.get(path);
    if (id === undefined) throw new Error(`no node id known for ${path}`);
    return id;
  }

  private project(rows: WireFileNode[]): Node[] {
    return rows.map((row) => {
      this.remember(row.path, row.id);
      return fromFileNode(row);
    });
  }

  /** `model.Node` rows only address a storage by name on the handlers that fill it in; a row without one is unusable. */
  private projectModel(rows: WireNode[]): Node[] {
    const out: Node[] = [];
    for (const row of rows) {
      if (!row.storage) continue;
      const node = fromModelNode(row, row.storage);
      this.remember(node.id, row.id);
      out.push(node);
    }
    return out;
  }

  private index(path: string): Promise<WireIndex> {
    return request<WireIndex>(MANAGER, { query: { q: 'index', path } });
  }

  /** The chips the listing endpoints do not take as query params yet; applied where the server would apply them. */
  private static narrow(nodes: Node[], filter?: ListingFilter): Node[] {
    return filter ? nodes.filter((n) => matchesFilter(n, filter)) : nodes;
  }

  /** Marks the rows the user has starred. One extra request per listing, and the only way filex reports the flag. */
  private async withStars(nodes: Node[]): Promise<Node[]> {
    const starred = new Set((await this.starredPaths()).map(String));
    for (const node of nodes) node.starred = starred.has(node.id);
    return nodes;
  }

  private async starredPaths(): Promise<string[]> {
    const { nodes } = await request<{ nodes: WireNode[] }>(`${MANAGER}/star/list`, { query: { limit: STARRED_LIMIT } });
    return this.projectModel(nodes).map((n) => n.id);
  }

  // ── storages, identity, features ────────────────────────────────────────────

  async listStorages(): Promise<Storage[]> {
    if (this.storages) return this.storages;
    const [{ storages }, quota] = await Promise.all([
      request<{ storages: WireStorage[] }>('/api/files/storages'),
      request<WireQuota>('/api/files/quota/me'),
    ]);
    const shared: Quota = toQuota(quota);
    this.storages = storages.map((s) => toStorage(s, shared));
    return this.storages;
  }

  async getStorage(id: string): Promise<Storage> {
    const found = (await this.listStorages()).find((s) => s.id === id);
    if (!found) throw new Error(`unknown storage: ${id}`);
    return found;
  }

  async currentUser(): Promise<User> {
    if (this.user) return this.user;
    const { user } = await request<{ user: WireUser }>('/api/auth/me');
    const name = user.display_name?.trim() || user.email;
    this.user = {
      id: String(user.id),
      name,
      initial: initialOf(name),
      email: user.email,
      role: user.role === 'admin' ? 'admin' : 'member',
    };
    return this.user;
  }

  /**
   * filex reports what the STORAGE DRIVERS can do; the rest of the block names features it has endpoints for but
   * does not advertise. Two are deliberately off: emptying the trash and deleting for good are admin-only routes
   * (`/api/admin/trash`), and there is no assistant or per-node activity feed at all — see docs/BACKEND-GAP.md.
   */
  async capabilities(): Promise<Capabilities> {
    const wire = await request<WireCapabilities>('/api/files/capabilities');
    return {
      ...noCapabilities(),
      upload: wire.upload ?? false,
      move: wire.move ?? false,
      copy: wire.copy ?? false,
      delete: wire.delete ?? false,
      mkdir: wire.mkdir ?? false,
      search: wire.search ?? false,
      versions: wire.versions ?? false,
      ocr: wire.ocr ?? false,
      tags: true,
      permissions: true,
    };
  }

  // ── the folder tree ─────────────────────────────────────────────────────────

  async listFolder(folderId: string, filter?: ListingFilter): Promise<Node[]> {
    const { files } = await this.index(folderId);
    return HttpRepository.narrow(await this.withStars(this.project(files)), filter);
  }

  /**
   * A folder is addressed, not looked up: the path IS the id. The listing still has to happen — it is what proves
   * the folder exists (a missing one 404s) and what fills in the item count the details panel shows.
   */
  async resolvePath(storageId: string, path: string): Promise<Node> {
    const id = joinPath(storageId, path);
    const { files } = await this.index(id);
    this.project(files);
    return this.folderStub(id, files.length);
  }

  /** A folder node built from its address. Used for the roots and the ancestors, which no listing row describes. */
  private folderStub(id: string, itemCount?: number): Node {
    const { adapter, rel } = splitPath(id);
    return {
      id,
      name: rel ? nameOf(id) : adapter,
      kind: 'folder',
      parentId: parentPath(id),
      size: 0,
      modifiedAt: new Date(0).toISOString(),
      ownerId: 'me',
      itemCount,
      shared: false,
      starred: false,
    };
  }

  async getNode(id: string): Promise<Node> {
    const parent = parentPath(id);
    if (!parent) return this.folderStub(id);
    const { files } = await this.index(parent);
    const row = this.project(files).find((n) => n.id === id);
    if (!row) throw new Error(`node not found: ${id}`);
    return row;
  }

  /**
   * The ancestors, derived rather than fetched: every one of them is a prefix of the node's own address, so the
   * chain costs no requests at all. This is the addressing scheme paying for itself.
   */
  async getPath(id: string): Promise<Node[]> {
    const chain: Node[] = [];
    for (let current = parentPath(id); current; current = parentPath(current)) chain.unshift(this.folderStub(current));
    return chain;
  }

  async listFolders(storageId: string): Promise<Node[]> {
    const root = joinPath(storageId, '');
    const out: Node[] = [this.folderStub(root)];
    const queue = [root];
    while (queue.length) {
      const { folders } = await request<{ folders: WireFileNode[] }>(MANAGER, { query: { q: 'subfolders', path: queue.shift()! } });
      for (const node of this.project(folders)) {
        out.push(node);
        queue.push(node.id);
      }
    }
    return out;
  }

  // ── listings beside the tree ────────────────────────────────────────────────

  async listRecent(filter?: ListingFilter): Promise<Node[]> {
    const { nodes } = await request<{ nodes: WireNode[] }>(`${MANAGER}/recent`, { query: { limit: RECENT_LIMIT } });
    // The endpoint answers newest-opened first; `openedAt` is what the Recent page sorts on, and filex reports the
    // order without the timestamp, so the order is preserved and the field left unset.
    const files = this.projectModel(nodes).filter((n) => n.kind === 'file');
    return HttpRepository.narrow(await this.withStars(files), filter);
  }

  async listStarred(filter?: ListingFilter): Promise<Node[]> {
    const { nodes } = await request<{ nodes: WireNode[] }>(`${MANAGER}/star/list`, { query: { limit: STARRED_LIMIT } });
    const starred = this.projectModel(nodes).map((n) => ({ ...n, starred: true }));
    return HttpRepository.narrow(starred, filter);
  }

  async listShared(filter?: ListingFilter): Promise<Node[]> {
    const { files } = await request<{ files: WireFileNode[] }>(`${MANAGER}/shared-with-me`);
    const shared = this.project(files).map((n) => ({ ...n, shared: true }));
    return HttpRepository.narrow(shared, filter);
  }

  async listTrash(filter?: ListingFilter): Promise<Node[]> {
    const { entries } = await request<{ entries: WireTrashEntry[] }>(`${MANAGER}/trash`, { query: { limit: TRASH_LIMIT } });
    const trashed = entries.map((entry) => {
      const node = fromTrashEntry(entry);
      this.remember(node.id, entry.id);
      return node;
    });
    return HttpRepository.narrow(trashed, filter);
  }

  // ── mutations ───────────────────────────────────────────────────────────────

  async createFolder(parentId: string, name: string): Promise<Node> {
    await request(MANAGER, { method: 'POST', query: { q: 'newfolder' }, body: { path: parentId, name } }).catch(asRepositoryError);
    return this.getNode(childPath(parentId, name));
  }

  async uploadFile(parentId: string, file: UploadInput): Promise<Node> {
    if (!file.blob) throw new Error('upload without bytes');
    const form = new FormData();
    form.set('path', parentId);
    form.append('file[]', file.blob, file.name);
    await upload(MANAGER, { q: 'upload' }, form).catch(asRepositoryError);
    return this.getNode(childPath(parentId, file.name));
  }

  async rename(id: string, name: string): Promise<Node> {
    const parent = parentPath(id);
    if (!parent) throw new Error('a storage root cannot be renamed');
    await request(MANAGER, { method: 'POST', query: { q: 'rename' }, body: { path: parent, item: id, name } }).catch(asRepositoryError);
    this.ids.delete(id);
    return this.getNode(childPath(parent, name));
  }

  /** filex's delete IS the move to trash: the bytes are renamed into `.filex-trash/` and the row keeps its id. */
  async moveToTrash(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await request(MANAGER, {
      method: 'POST',
      query: { q: 'delete' },
      body: { path: parentPath(ids[0]) ?? ids[0], items: ids.map((path) => ({ path })) },
    });
    for (const id of ids) this.ids.delete(id);
  }

  async restore(ids: string[]): Promise<void> {
    for (const id of ids) {
      await request(`${MANAGER}/restore`, { method: 'POST', body: { node_id: this.nodeId(id) } });
    }
  }

  /** Purging is `/api/admin/trash/{id}`; an ordinary account cannot reach it, which is why the capability is off. */
  async deleteForever(): Promise<void> {
    throw new Error('deleting forever is an administrator action on this server');
  }

  async emptyTrash(): Promise<void> {
    throw new Error('emptying the trash is an administrator action on this server');
  }

  async setStarred(ids: string[], starred: boolean): Promise<void> {
    for (const id of ids) {
      await request(`${MANAGER}/star`, { method: 'POST', body: { node_id: this.nodeId(id), starred } });
    }
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await request(`${MANAGER}/tags`, { method: 'POST', body: { node_id: this.nodeId(id), tags } });
  }

  async move(ids: string[], targetFolderId: string): Promise<void> {
    if (!ids.length) return;
    await request(MANAGER, {
      method: 'POST',
      query: { q: 'move' },
      body: { path: targetFolderId, items: ids.map((path) => ({ path })) },
    }).catch(asRepositoryError);
    for (const id of ids) this.ids.delete(id);
  }

  async createShareLink(id: string): Promise<string> {
    const { url } = await request<{ url: string }>('/api/files/share', { method: 'POST', body: { path: id } });
    return url;
  }

  async removeShareLink(id: string): Promise<void> {
    const { shares } = await request<{ shares: { id: number }[] }>('/api/files/share', { query: { path: id } });
    for (const share of shares) await request(`/api/files/share/${share.id}`, { method: 'DELETE' });
  }

  async recordOpen(id: string): Promise<void> {
    await request(`${MANAGER}/recent`, { method: 'POST', body: { node_id: this.nodeId(id) } });
  }

  // ── access, history ─────────────────────────────────────────────────────────

  async listPeople(nodeId: string): Promise<Person[]> {
    const { direct, inherited } = await request<{ direct: WireGrant[]; inherited: WireGrant[] }>('/api/files/permissions', { query: { path: nodeId } });
    const seen = new Set<string>();
    const people: Person[] = [];
    for (const grant of [...direct, ...inherited]) {
      const id = String(grant.user_id);
      if (seen.has(id)) continue;
      seen.add(id);
      this.grants.set(`${nodeId}|${id}`, grant.id);
      const name = grant.user_display_name?.trim() || grant.user_email || id;
      people.push({ id, name, initial: initialOf(name), role: LEVELS[grant.level] ?? 'viewer' });
    }
    return people;
  }

  /** By email, because that is the only handle the person adding someone has; filex resolves or creates the account. */
  async addPerson(nodeId: string, email: string, role: Person['role']): Promise<void> {
    await request('/api/files/permissions/invite', {
      method: 'POST',
      body: { path: nodeId, email, level: role, is_dir: true },
    });
  }

  async setPersonRole(nodeId: string, personId: string, role: Person['role']): Promise<void> {
    await request(`/api/files/permissions/${this.grantId(nodeId, personId)}`, { method: 'PATCH', body: { level: role } });
  }

  async removePerson(nodeId: string, personId: string): Promise<void> {
    await request(`/api/files/permissions/${this.grantId(nodeId, personId)}`, { method: 'DELETE' });
  }

  private grantId(nodeId: string, personId: string): number {
    const id = this.grants.get(`${nodeId}|${personId}`);
    if (id === undefined) throw new Error(`no grant known for ${personId} on ${nodeId}`);
    return id;
  }

  /**
   * filex records the size and the instant of every revision but not who wrote it — the version rows carry no
   * author. Rather than invent one, every revision is attributed to the account reading it.
   */
  async listVersions(nodeId: string): Promise<Version[]> {
    const { versions } = await request<{ versions: WireVersion[] | null }>('/api/files/versions', { query: { node_id: this.nodeId(nodeId) } });
    const me = await this.currentUser();
    const rows = [...(versions ?? [])].sort((a, b) => b.version_n - a.version_n);
    return rows.map((v, i) => ({
      id: String(v.id),
      at: v.created_at,
      size: v.size,
      authorId: me.id,
      authorName: me.name,
      current: i === 0,
    }));
  }

  async restoreVersion(nodeId: string, versionId: string): Promise<void> {
    await request('/api/files/versions/restore', {
      method: 'POST',
      body: { node_id: this.nodeId(nodeId), version_id: Number(versionId), snapshot_current: true },
    });
  }

  /** filex keeps an admin audit log, not a per-node feed; the panel's Activity tab stays empty until one exists. */
  async listActivity(): Promise<ActivityEvent[]> {
    return [];
  }

  /** The People chip offers the owners filex could report per listing — it reports none, so the chip has no options. */
  async listFilterPeople(): Promise<Person[]> {
    return [];
  }

  // ── search ──────────────────────────────────────────────────────────────────

  /**
   * filex's search takes a query string, a scope and a limit. Everything else the advanced form offers — the date
   * window, the type group, the size band, the owner — has no query param, so it is applied to the answer here,
   * through the same predicate the listing chips use.
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const scope = query.scope === 'content' ? 'content' : query.scope === 'paths' ? 'path' : '';
    const text = query.tags.length ? [query.text, ...query.tags.map((t) => `tag:${t}`)].join(' ').trim() : query.text;
    const { results } = await request<{ results: (WireNode & { snippet?: string })[] }>('/api/files/search', {
      query: { q: text, limit: SEARCH_LIMIT, scope: scope || undefined },
    });
    const hits: SearchHit[] = [];
    for (const row of results) {
      if (!row.storage) continue;
      const node = fromModelNode(row, row.storage);
      this.remember(node.id, row.id);
      if (!matchesFilter(node, { fileType: query.fileType, modified: query.modified, size: query.size.preset === 'custom' ? 'any' : query.size.preset, personId: query.ownerId })) continue;
      const parent = parentPath(node.id);
      hits.push({
        node,
        storageId: row.storage,
        folderPath: parent ? splitPath(parent).rel : '',
        ...(row.snippet ? { snippet: { text: row.snippet, ranges: [] } } : {}),
      });
    }
    return { hits, total: hits.length };
  }

  /** No assistant endpoint exists; the capability is off, so the panel is never reachable to call this. */
  // eslint-disable-next-line require-yield
  async *assistantAsk(): AsyncIterable<AssistantEvent> {
    throw new Error('this server has no assistant');
  }
}
