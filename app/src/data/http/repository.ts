import { DUPLICATE_NAME, OPERATION_PENDING, WRONG_PASSWORD, type Repository } from '../repository';
import { matchesFilter, MODIFIED_WINDOW_DAYS, SIZE_PRESET_BYTES, TYPE_GROUPS } from '../listingFilter';
import { extensionsOf } from '../fileTypes';
import { noCapabilities, type Access, type ActivityEvent, type AssistantCard, type AssistantConversation, type AssistantMode, type PlanOutcome, type PlanResult, type AssistantSession, type AssistantEvent, type AuthMethods, type Capabilities, type ListingFilter, type Node, type Person, type ProfilePatch, type SearchHit, type SearchQuery, type NotifyPrefs, type SearchResult, type Session, type Storage, type UploadInput, type UploadOptions, type UploadSession, type User, type Version } from '../types';
import { HttpError, putChunk, request, streamJSON } from './client';
import {
  fromFileNode,
  fromActivityEvent,
  fromModelNode,
  fromTrashEntry,
  joinPath,
  nameOf,
  parentPath,
  SELF,
  splitPath,
  toQuota,
  toStorage,
  type WireFileNode,
  type WireIndex,
  type WireNode,
  type WireOp,
  type WireQuota,
  type WireStorage,
  type WireAuthMethods,
  fromSession,
  type WireSession,
  type WireActivityEvent,
  type WireTrashEmpty,
  type WireTrashEntry,
  type WireUploadBegin,
  type WireUploadCommit,
  type WireUploadPut,
  type WireUploadStatus,
  fromAssistantHit,
  type WireAssistantHit,
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

/**
 * Copy, move and the move to trash all run through filex's ops queue: the call submits a job and then polls the row
 * until it is finished. The manager also has synchronous forms of move and delete, and this used to use them — but a
 * subtree big enough to take minutes held one request open for all of it, which is what proxies cut at sixty seconds
 * and report as a failure for work that was in fact going to succeed. A submit answers in milliseconds and every
 * poll after it is its own short request, so nothing in between has a reason to time out.
 *
 * `POLL_STEP_MS` doubles up to `POLL_MAX_MS` — a single file is done on the first check, and a large subtree stops
 * being asked about ten times a second.
 */
const OPS = '/api/files/ops';
const POLL_STEP_MS = 150;
const POLL_MAX_MS = 2000;
/**
 * How long to keep waiting before handing the job back to the server. The worker is restart-safe and carries on
 * either way, so this is not a cancellation — it is the point at which the app stops pretending the user is still
 * waiting for an answer.
 */
const POLL_GIVE_UP_MS = 60_000;

/**
 * Staged uploads (docs/UPLOADS.md): `begin` opens a session, each `PUT` carries one chunk and answers with the
 * offset the server now holds, `commit` turns the staging area into a node. The chunk size the server hands back
 * is binding; this is only what to ask for, and what to fall back on if it says nothing.
 *
 * 1 MiB rather than the server's 8 MiB default, because the chunk is also the resolution of the progress bar and
 * the unit a failure costs: at 8 MiB most documents would be one chunk, and their bar would only ever read 0 or
 * 100. The extra round trips are cheap next to the bytes they carry.
 */
const NOTIFY_SETTINGS = '/api/notifications/settings';
const ASSISTANT_SESSIONS = '/api/assistant/sessions';
const ASSISTANT_STATUS = '/api/assistant/status';

/** One frame of the turn stream; filex carries the kind inside the payload rather than on an `event:` line. */
interface WireAssistantEvent {
  type: 'meta' | 'text' | 'tool' | 'card' | 'hits' | 'title' | 'error' | 'done';
  conversation_id?: string;
  delta?: string;
  message?: string;
  /** `title`: the name the server gave this conversation. */
  title?: string;
  /** `hits`: what a search found, for the panel's result cards. */
  hits?: WireAssistantHit[];
  /** `tool`: which tool, and the path or query it was given. */
  tool?: string;
  target?: string;
  /** `card`: the kind of decision and what it is about. */
  kind?: string;
  path?: string;
  reason?: string;
  /** `card` of kind `plan`: the stored plan, its work and its state. */
  plan_id?: string;
  plan_kind?: string;
  summary?: string;
  status?: string;
  items?: WirePlanItem[];
}

interface WirePlanItem {
  path: string;
  action: string;
  args?: Record<string, string>;
  size?: number;
  at?: string;
}

interface WirePlanResult {
  path: string;
  state: string;
  code?: string;
  reason?: string;
}

/** A stored card, as the messages endpoint redraws it — a plan is hydrated from the plan row, not from the message. */
interface WireCard {
  kind: string;
  path?: string;
  reason?: string;
  plan_id?: string;
  plan_kind?: string;
  summary?: string;
  status?: string;
  items?: WirePlanItem[];
  results?: WirePlanResult[];
}

function fromPlanResult(wire: WirePlanResult): PlanResult {
  const state = wire.state === 'done' || wire.state === 'skipped' ? wire.state : 'failed';
  return { path: wire.path, state, ...(wire.code ? { code: wire.code } : {}), ...(wire.reason ? { reason: wire.reason } : {}) };
}

/** One stored card in the shape the panel draws. An unknown kind is dropped rather than rendered as an empty box. */
function fromCard(wire: WireCard): AssistantCard | null {
  if (wire.kind === 'plan') {
    return {
      kind: 'plan',
      id: wire.plan_id ?? '',
      planKind: wire.plan_kind ?? '',
      summary: wire.summary ?? '',
      items: wire.items ?? [],
      status: wire.status === 'done' || wire.status === 'cancelled' ? wire.status : 'pending',
      ...(wire.results?.length ? { results: wire.results.map(fromPlanResult) } : {}),
    };
  }
  if (wire.kind === 'approval') return { kind: 'approval', path: wire.path ?? '', reason: wire.reason };
  return null;
}

/**
 * Which filex event each switch of the Notifications tab stands for. A failed upload is deliberately not
 * part of "finished uploads": muting the good news must not silence the bad.
 */
const NOTIFY_EVENTS = { shared: 'share.created', comments: 'comment.added', uploads: 'file.uploaded' } as const;

/** `model.NotificationSettings` — the per-user mute list, shared with every other client of the account. */
interface WireNotifySettings {
  in_app_enabled?: boolean;
  muted_events?: string[];
}

const UPLOAD = '/api/files/upload';
const CHUNK_BYTES = 1024 * 1024;

/** How many rows the metadata listings return; filex caps starred at 500 and recent at 200. */
const STARRED_LIMIT = 500;
const RECENT_LIMIT = 200;
/**
 * How many times `emptyTrash` may go round. The server caps one request so it stays short; this caps the client so
 * a server that keeps saying "more" can never turn one click into an unbounded stream of requests.
 */
const EMPTY_TRASH_ROUNDS = 40;
const TRASH_LIMIT = 500;
/** The server's own maximum for `shared-with-me`, which is narrowed here rather than in the query — see `listShared`. */
const SHARED_LIMIT = 500;
const SEARCH_LIMIT = 100;

/** filex answers a name collision with 409 on every write verb; the modals expect the shared error. */
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_UNIT_BYTES = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;

/**
 * The advanced form as request fields. Extensions rather than a group name, because which extensions count as
 * "documents" is the app's word and `extensionsOf` is where it is kept — the server holds no second copy of it.
 */
function searchFacets(query: SearchQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `searchIn`, not `scope`: the scope picks which FIELDS are consulted, this picks WHERE.
  if (query.searchIn === 'current' && query.folderPath) out.path_prefix = `/${query.folderPath}`;
  if (query.fileType !== 'any') out.ext = extensionsOf(TYPE_GROUPS[query.fileType]);
  if (query.modified !== 'any') out.modified_after = Date.now() - MODIFIED_WINDOW_DAYS[query.modified] * DAY_MS;
  if (query.size.preset !== 'any' && query.size.preset !== 'custom') {
    const [min, max] = SIZE_PRESET_BYTES[query.size.preset];
    if (min > 0) out.size_min = min;
    if (Number.isFinite(max)) out.size_max = max;
  }
  // The owner is filex's numeric user id, which is exactly what the People chip carries as a Person id.
  const owner = Number(query.ownerId);
  if (query.ownerId && Number.isFinite(owner)) out.owner_id = owner;
  return out;
}

/**
 * The filter chips above a listing, as query parameters.
 *
 * The same words the advanced search uses — `ext`, `modified_after`, `size_min`, `size_max`, `owner_id` — because
 * both are the same question asked of different row sets, and two vocabularies for one question is one of them
 * going stale. Extensions rather than a group name for the same reason as there: `extensionsOf` is where "documents"
 * is defined, and the server holds no second copy of it.
 *
 * They are sent rather than sieved because these listings are capped. A chip applied to the page instead of to the
 * query answers with the matches among the newest N rows and gives no sign of it — "no images among your starred
 * files" reads identically whether there are none or whether they are all past number five hundred.
 */
function listingFacets(filter?: ListingFilter): Record<string, string | number | undefined> {
  if (!filter) return {};
  const out: Record<string, string | number | undefined> = {};
  // Comma-joined: `withQuery` writes one value per key, and the server reads both spellings.
  if (filter.fileType !== 'any') out.ext = extensionsOf(TYPE_GROUPS[filter.fileType]).join(',');
  if (filter.modified !== 'any') out.modified_after = Date.now() - MODIFIED_WINDOW_DAYS[filter.modified] * DAY_MS;
  if (filter.size !== 'any') {
    const [min, max] = SIZE_PRESET_BYTES[filter.size];
    if (min > 0) out.size_min = min;
    if (Number.isFinite(max)) out.size_max = max;
  }
  const owner = Number(filter.personId);
  if (filter.personId && Number.isFinite(owner)) out.owner_id = owner;
  return out;
}

/** The text as one phrase, with any quotes of its own removed — a stray one would make the whole form unreadable. */
function quoted(text: string): string {
  const inner = text.replaceAll('"', ' ').trim();
  return inner ? `"${inner}"` : '';
}

/**
 * The one size form the server has no expression for: a hand-typed range. The presets became `size_min`/`size_max`
 * on the request; this stays here because the form allows a range in whichever unit the user picked.
 */
function withinCustomSize(node: Node, size: SearchQuery['size']): boolean {
  if (node.kind !== 'file') return false;
  const unit = SIZE_UNIT_BYTES[size.unit] ?? 1;
  if (size.min !== null && node.size < size.min * unit) return false;
  if (size.max !== null && node.size > size.max * unit) return false;
  return true;
}

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
  avatar_url?: string;
  locale?: string;
  timezone?: string;
  full_name?: string;
  job_title?: string;
}

/** An account with no display name is shown by the address it signs in with, which is what it has. */
function toUser(wire: WireUser): User {
  const name = wire.display_name?.trim() || wire.email;
  return {
    id: String(wire.id),
    name,
    initial: initialOf(name),
    email: wire.email,
    role: wire.role === 'admin' ? 'admin' : 'member',
    avatarUrl: wire.avatar_url || undefined,
    fullName: wire.full_name || undefined,
    jobTitle: wire.job_title || undefined,
    locale: wire.locale || undefined,
    timeZone: wire.timezone || undefined,
  };
}

/** `chatSessionView` from the server: metadata only, never message text. */
interface WireChatSession {
  id: string;
  title: string;
  title_manual: boolean;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

interface WireChatMessage {
  id: string;
  role: string;
  content: string;
  aborted: boolean;
  secret_notice: boolean;
  created_at: string;
  /** The questions this turn raised; a plan card is redrawn from the plan row, so its state is current. */
  cards?: WireCard[];
  /** What the searches in this turn found, stored with the answer. */
  hits?: WireAssistantHit[];
}

function fromChatSession(wire: WireChatSession): AssistantSession {
  return {
    id: wire.id,
    title: wire.title,
    titleManual: wire.title_manual,
    messageCount: wire.message_count,
    lastActiveAt: wire.last_active_at,
    createdAt: wire.created_at,
  };
}

interface WireVersion {
  id: number;
  node_id: number;
  version_n: number;
  size: number;
  created_at: string;
  /** Absent on revisions taken before filex recorded who took them; there is no backfill for those. */
  created_by?: number;
  author_name?: string;
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
  /**
   * Numeric ids of the nodes this session put in the trash. `ids` has to forget the path — it is free again, and a
   * new node may take it — but `restore` addresses the trashed row by number, and Undo restores without ever
   * listing the trash first.
   */
  private readonly trashed = new Map<string, number>();
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
      const node = fromFileNode(row);
      if (row.owner_id === undefined) return { ...node, ownerId: this.owner() };
      if (!this.people.has(node.ownerId)) {
        this.people.set(node.ownerId, { id: node.ownerId, name: node.ownerName ?? node.ownerId, initial: initialOf(node.ownerName ?? '?'), role: 'owner' });
      }
      return node;
    });
  }

  /**
   * The fallback owner for a row filex named none for — anything a storage sync found rather than a person
   * uploading it. Everything the caller can see, they can see, so the account's own id is the honest answer, and
   * saying it with the real id rather than a sentinel is what lets the panel print "You".
   */
  private owner(): string {
    return this.user?.id ?? SELF;
  }

  /**
   * The People chip's options, learned from the listings this session has read.
   *
   * There is no endpoint that answers "who might own something here", and a DISTINCT over the node table would be
   * the wrong one: it would name owners of folders the caller cannot open. What the rows themselves carried is both
   * the set that is safe to offer and the only set a filter over those rows can match.
   */
  private readonly people = new Map<string, Person>();

  /** `model.Node` rows only address a storage by name on the handlers that fill it in; a row without one is unusable. */
  private projectModel(rows: WireNode[]): Node[] {
    const out: Node[] = [];
    for (const row of rows) {
      if (!row.storage) continue;
      const node = fromModelNode(row, row.storage);
      this.remember(node.id, row.id);
      out.push({ ...node, ownerId: this.owner() });
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
    // The ceiling is the account's; what each drive HOLDS is the drive's own, and the two used to be the same figure.
    const { totalBytes } = toQuota(quota);
    this.storages = storages.map((s) => toStorage(s, totalBytes));
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
    this.user = toUser(user);
    return this.user;
  }

  /**
   * The account fields the modal owns, in one PATCH. filex answers with the whole user row, so the store gets the
   * value the server actually stored — a display name it trimmed, or an avatar it refused.
   */
  async updateProfile(patch: ProfilePatch): Promise<User> {
    const wire = await request<WireUser>('/api/auth/profile', {
      method: 'PATCH',
      body: {
        ...(patch.name === undefined ? {} : { display_name: patch.name }),
        ...(patch.fullName === undefined ? {} : { full_name: patch.fullName }),
        ...(patch.jobTitle === undefined ? {} : { job_title: patch.jobTitle }),
        ...(patch.locale === undefined ? {} : { locale: patch.locale }),
        ...(patch.timeZone === undefined ? {} : { timezone: patch.timeZone }),
        ...(patch.avatarUrl === undefined ? {} : { avatar_url: patch.avatarUrl }),
      },
    });
    this.user = toUser(wire);
    return this.user;
  }

  /** filex checks the old password itself and answers 401 when it is wrong; every other status is a real failure. */
  archiveUrl(nodes: Node[]): string | null {
    if (!nodes.length) return null;
    const query = new URLSearchParams(nodes.map((node) => ['path', node.id]));
    // One thing selected is named after it; a mixed selection has no name of its own and the server picks one.
    if (nodes.length === 1) query.set('name', `${nodes[0].name}.zip`);
    return `/api/files/download/zip?${query.toString()}`;
  }

  async authMethods(): Promise<AuthMethods> {
    const wire = await request<WireAuthMethods>('/api/auth/methods');
    return { provider: wire.provider, changePassword: wire.change_password, totpEnabled: wire.totp_enabled };
  }

  /**
   * filex stores the opposite of what the modal shows — a list of MUTED events — and that list is shared with
   * every other client of the account, so what the app does not own is read back and written out untouched.
   */
  async notifyPrefs(): Promise<NotifyPrefs> {
    const wire = await request<WireNotifySettings>(NOTIFY_SETTINGS);
    const muted = new Set(wire.muted_events ?? []);
    const on = (event: string) => wire.in_app_enabled !== false && !muted.has(event);
    return { shared: on(NOTIFY_EVENTS.shared), comments: on(NOTIFY_EVENTS.comments), uploads: on(NOTIFY_EVENTS.uploads) };
  }

  async saveNotifyPrefs(prefs: NotifyPrefs): Promise<void> {
    const wire = await request<WireNotifySettings>(NOTIFY_SETTINGS);
    const muted = new Set(wire.muted_events ?? []);
    for (const [key, event] of Object.entries(NOTIFY_EVENTS)) {
      if (prefs[key as keyof NotifyPrefs]) muted.delete(event);
      else muted.add(event);
    }
    await request(NOTIFY_SETTINGS, {
      method: 'PATCH',
      // Switching one back on has to switch the master back on too, or the server keeps everything quiet.
      body: { in_app_enabled: true, muted_events: [...muted] },
    });
  }

  /** Every sign-in of this account that has not expired; the row this app is calling with says so itself. */
  async listSessions(): Promise<Session[]> {
    const wire = await request<{ sessions: WireSession[] }>('/api/auth/sessions');
    return (wire.sessions ?? []).map(fromSession);
  }

  async revokeSession(id: string): Promise<void> {
    await request(`/api/auth/sessions/${id}`, { method: 'DELETE' });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await request('/api/auth/password', { method: 'POST', body: { old_password: currentPassword, new_password: newPassword } });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) throw new Error(WRONG_PASSWORD);
      throw error;
    }
  }

  /**
   * filex reports what the STORAGE DRIVERS can do; the rest of the block names features it has endpoints for but
   * does not advertise. Two are deliberately off: emptying the trash and deleting for good are admin-only routes
   * (`/api/admin/trash`), and there is no assistant or per-node activity feed at all — see docs/BACKEND-GAP.md.
   */
  async capabilities(): Promise<Capabilities> {
    const [wire, assistant] = await Promise.all([request<WireCapabilities>('/api/files/capabilities'), this.assistantEnabled()]);
    return {
      ...noCapabilities(),
      assistant,
      upload: wire.upload ?? false,
      move: wire.move ?? false,
      copy: wire.copy ?? false,
      delete: wire.delete ?? false,
      mkdir: wire.mkdir ?? false,
      search: wire.search ?? false,
      versions: wire.versions ?? false,
      tags: true,
      permissions: true,
      // Not reported by /capabilities — filex answers for the storage DRIVERS, and zipping a subtree is filex's
      // own work, not the driver's. The endpoint exists (`GET /api/files/download/zip`), so the answer is yes.
      folderDownload: true,
      // Same reasoning: purging is filex's own bookkeeping, and the caller now has routes of their own for it
      // (`DELETE /manager/trash/{id}`, `POST /manager/trash/empty`) rather than only the admin's.
      deleteForever: true,
      // And the per-node event feed (`GET /api/files/activity`), which the details panel's second tab needs.
      activity: true,
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
      ownerId: this.owner(),
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
    const { nodes } = await request<{ nodes: WireNode[] }>(`${MANAGER}/recent`, {
      query: { limit: RECENT_LIMIT, ...listingFacets(filter) },
    });
    // The endpoint answers newest-opened first; `openedAt` is what the Recent page sorts on, and filex reports the
    // order without the timestamp, so the order is preserved and the field left unset.
    const files = this.projectModel(nodes).filter((n) => n.kind === 'file');
    return this.withStars(files);
  }

  async listStarred(filter?: ListingFilter): Promise<Node[]> {
    const { nodes } = await request<{ nodes: WireNode[] }>(`${MANAGER}/star/list`, {
      query: { limit: STARRED_LIMIT, ...listingFacets(filter) },
    });
    return this.projectModel(nodes).map((n) => ({ ...n, starred: true }));
  }

  /**
   * The one listing still narrowed here. Its rows are not node rows — a grant can name a path the indexer has never
   * walked, and such a row has no size, date or owner for a query to test — so the endpoint takes no facets. What it
   * does do is build the whole set before paging it, so asking for its maximum page makes the chips exact up to that
   * many shared items rather than up to the default hundred.
   */
  async listShared(filter?: ListingFilter): Promise<Node[]> {
    const { files } = await request<{ files: WireFileNode[] }>(`${MANAGER}/shared-with-me`, { query: { limit: SHARED_LIMIT } });
    const shared = this.project(files).map((n) => ({ ...n, shared: true }));
    return HttpRepository.narrow(shared, filter);
  }

  async listTrash(filter?: ListingFilter): Promise<Node[]> {
    // `top_level_only`: one row per thing the user deleted. Without it a deleted folder arrives together with every
    // file it contained, each offering a Restore that only the folder's own restore actually performs.
    const { entries } = await request<{ entries: WireTrashEntry[] }>(`${MANAGER}/trash`, {
      query: { limit: TRASH_LIMIT, top_level_only: 1, ...listingFacets(filter) },
    });
    return entries.map((entry) => {
      const node = fromTrashEntry(entry);
      this.remember(node.id, entry.id);
      return node;
    });
  }

  // ── mutations ───────────────────────────────────────────────────────────────

  async createFolder(parentId: string, name: string): Promise<Node> {
    await request(MANAGER, { method: 'POST', query: { q: 'newfolder' }, body: { path: parentId, name } }).catch(asRepositoryError);
    return this.getNode(childPath(parentId, name));
  }

  /**
   * The staged path, not the one-shot multipart POST. Three things come with it: the server accepts the file a
   * chunk at a time, so progress is a fact rather than a timer; a chunk that fails is the only thing retried; and
   * `commit` answers before the bytes reach the storage driver, so the transfer is a queued op like copy is —
   * waiting for it is what makes a finished row in the tray mean the file is really there.
   */
  async uploadFile(parentId: string, file: UploadInput, options?: UploadOptions): Promise<Node> {
    const blob = file.blob;
    if (!blob) throw new Error('upload without bytes');
    const session = await request<WireUploadBegin>(`${UPLOAD}/begin`, {
      method: 'POST',
      body: { path: parentId, name: file.name, size: blob.size, mime: blob.type || undefined, chunk_size: CHUNK_BYTES },
      signal: options?.signal,
    }).catch(asRepositoryError);
    // ⚠ Told to the caller BEFORE a byte moves. `begin` always opens a new
    // session at offset 0 — it never picks up an old one — so an id nobody
    // wrote down is a staged upload nobody can ever continue, only expire.
    options?.onSession?.(session.id);
    return this.pump(session.id, parentId, file, blob, session.offset ?? 0, session.chunk_size ?? session.chunkSize ?? CHUNK_BYTES, options);
  }

  async uploadSession(id: string): Promise<UploadSession | null> {
    try {
      const wire = await request<WireUploadStatus>(`${UPLOAD}/${id}`);
      // A session the server has finished with is not one to carry on.
      if (wire.state && wire.state !== 'staging') return null;
      return { id, offset: wire.offset ?? 0, size: wire.total_size ?? wire.totalSize ?? 0 };
    } catch {
      // Gone, expired, or never ours. Either way there is nothing to resume.
      return null;
    }
  }

  /**
   * ⚠ The bytes are not checked against the ones the session was begun for — the server knows only sizes, and the
   * browser cannot hold a `File` across a reload. The caller compares the name and the size before calling this;
   * that is as much as either side can do, and it is why the resume flow asks the person to pick the file again
   * rather than resuming something it merely hopes is the same.
   */
  async resumeUpload(id: string, parentId: string, file: UploadInput, options?: UploadOptions): Promise<Node> {
    const blob = file.blob;
    if (!blob) throw new Error('upload without bytes');
    const wire = await request<WireUploadStatus>(`${UPLOAD}/${id}`).catch(asRepositoryError);
    return this.pump(id, parentId, file, blob, wire.offset ?? 0, wire.chunk_size ?? wire.chunkSize ?? CHUNK_BYTES, options);
  }

  async abortUpload(id: string): Promise<void> {
    await request(`${UPLOAD}/${id}`, { method: 'DELETE' }).catch(asRepositoryError);
  }

  /** The chunk loop, from `from` to the end, then the commit. Shared by a fresh upload and a resumed one. */
  private async pump(
    id: string,
    parentId: string,
    file: UploadInput,
    blob: Blob,
    from: number,
    chunk: number,
    options?: UploadOptions,
  ): Promise<Node> {
    let sent = from;
    options?.onProgress?.(sent, blob.size);
    while (sent < blob.size) {
      const end = Math.min(sent + chunk, blob.size);
      // The server's offset wins over the arithmetic: a short chunk is refused and leaves the offset where it was.
      const accepted = await putChunk<WireUploadPut>(`${UPLOAD}/${id}`, `bytes ${sent}-${end - 1}/${blob.size}`, blob.slice(sent, end), options?.signal);
      sent = accepted.offset ?? end;
      options?.onProgress?.(sent, blob.size);
    }

    const commit = await request<WireUploadCommit>(`${UPLOAD}/${id}/commit`, { method: 'POST', signal: options?.signal }).catch(asRepositoryError);
    await this.awaitOpId(commit.op_id ?? commit.opId);
    return this.getNode(childPath(parentId, file.name));
  }

  async rename(id: string, name: string): Promise<Node> {
    const parent = parentPath(id);
    if (!parent) throw new Error('a storage root cannot be renamed');
    await request(MANAGER, { method: 'POST', query: { q: 'rename' }, body: { path: parent, item: id, name } }).catch(asRepositoryError);
    this.ids.delete(id);
    return this.getNode(childPath(parent, name));
  }

  /**
   * filex's delete IS the move to trash: the bytes are renamed into `.filex-trash/` and the row keeps its id, which
   * is what makes Restore possible. The queued worker performs the identical soft delete as the synchronous handler
   * — the same `trash.Put`, the same retag — so nothing about what lands in the trash changes with the route here.
   */
  async moveToTrash(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.submitOp('delete', { source: ids });
    for (const id of ids) {
      const numeric = this.ids.get(id);
      if (numeric !== undefined) this.trashed.set(id, numeric);
      this.ids.delete(id);
    }
  }

  /** Either the trash listing named this row, or this session trashed it and kept its number. */
  private trashedNodeId(id: string): number {
    const numeric = this.trashed.get(id) ?? this.ids.get(id);
    if (numeric === undefined) throw new Error(`no node id known for ${id}`);
    return numeric;
  }

  async restore(ids: string[]): Promise<void> {
    for (const id of ids) {
      const numeric = this.trashedNodeId(id);
      await request(`${MANAGER}/restore`, { method: 'POST', body: { node_id: numeric } });
      this.trashed.delete(id);
      this.ids.set(id, numeric);
    }
  }

  /** One entry at a time; purging a deleted FOLDER takes everything that went into the trash inside it. */
  async deleteForever(ids: string[]): Promise<void> {
    for (const id of ids) {
      await request(`${MANAGER}/trash/${this.trashedNodeId(id)}`, { method: 'DELETE' }).catch(asRepositoryError);
      this.trashed.delete(id);
      this.ids.delete(id);
    }
  }

  /**
   * The server purges a bounded number of entries per request and says whether more is left, so no single call has
   * to hold open for a trash of any size. Loop while it is still making progress: `more` on its own would spin
   * against entries this caller can see and may not purge, which the server skips rather than failing over.
   */
  async emptyTrash(): Promise<void> {
    for (let round = 0; round < EMPTY_TRASH_ROUNDS; round++) {
      const answer = await request<WireTrashEmpty>(`${MANAGER}/trash/empty`, { method: 'POST' });
      if (!answer.more || !answer.purged) break;
    }
    this.trashed.clear();
  }

  async setStarred(ids: string[], starred: boolean): Promise<void> {
    for (const id of ids) {
      await request(`${MANAGER}/star`, { method: 'POST', body: { node_id: this.nodeId(id), starred } });
    }
  }

  /**
   * Read per node, because no listing carries tags: without this the tag modal opened EMPTY on a file that had
   * tags, and saving from there wiped them. The server also normalises what it stores — lower case, nothing over
   * 64 characters — so what comes back is what the file actually has, not what somebody typed.
   */
  async listTags(id: string): Promise<string[]> {
    const { tags } = await request<{ tags: string[] | null }>(`${MANAGER}/tags`, { query: { node_id: this.nodeId(id) } });
    return tags ?? [];
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await request(`${MANAGER}/tags`, { method: 'POST', body: { node_id: this.nodeId(id), tags } });
  }

  async move(ids: string[], targetFolderId: string): Promise<void> {
    if (!ids.length) return;
    await this.submitOp('move', { source: ids, target: targetFolderId });
    // Every moved node now answers to a different address, so the numbers remembered against the old ones are stale.
    for (const id of ids) this.ids.delete(id);
  }

  /**
   * filex names the copy itself (`<base>-copy<ext>` when the name is taken), so nothing is returned: the caller
   * re-reads the folder and sees what landed.
   */
  async copy(ids: string[], targetFolderId: string): Promise<void> {
    if (!ids.length) return;
    await this.submitOp('copy', { source: ids, target: targetFolderId });
  }

  /** Queues one job on `POST /api/files/{verb}` and waits for it. The submit's own 4xx is still a 4xx. */
  private async submitOp(verb: 'copy' | 'move' | 'delete', body: Record<string, unknown>): Promise<void> {
    const { op } = await request<{ op: WireOp }>(`/api/files/${verb}`, { method: 'POST', body }).catch(asRepositoryError);
    await this.awaitOp(op);
  }

  /**
   * Polls one queued op to its end. A failed job throws so the store's error path owns it, as a 4xx would; a job
   * still running when the wait runs out raises OPERATION_PENDING, which says something different — nothing went
   * wrong, the answer is simply not in yet, and the caller must neither claim success nor offer to undo half a move.
   */
  private async awaitOp(op: WireOp): Promise<void> {
    const deadline = Date.now() + POLL_GIVE_UP_MS;
    let current = op;
    for (let wait = POLL_STEP_MS; current.status === 'pending' || current.status === 'running'; wait = Math.min(wait * 2, POLL_MAX_MS)) {
      if (Date.now() > deadline) throw new Error(OPERATION_PENDING);
      await new Promise((resolve) => setTimeout(resolve, wait));
      current = await request<WireOp>(`${OPS}/${op.id}`);
    }
    if (current.status !== 'ok') throw new Error(current.error || `${current.kind} ${current.status}`);
  }

  /** The same wait, for a verb that answers with an op id instead of the op: the first poll fetches the row. */
  private async awaitOpId(id: number | undefined): Promise<void> {
    if (id === undefined) return;
    await this.awaitOp({ id, kind: 'upload-commit', status: 'pending' });
  }

  async createShareLink(id: string): Promise<string> {
    const { url } = await request<{ url: string }>('/api/files/share', { method: 'POST', body: { path: id } });
    return url;
  }

  /**
   * Empty for a node with no link — and also for one shared by SOMEBODY ELSE: filex lists a non-admin only the
   * links they minted themselves, and refuses the question below editor. Either way the answer is "no link of
   * yours to show", which is what the panel can honestly offer to remove.
   */
  async shareLink(id: string): Promise<string | null> {
    const shares = await this.shares(id);
    return shares[0]?.url ?? null;
  }

  async removeShareLink(id: string): Promise<void> {
    for (const share of await this.shares(id)) await request(`/api/files/share/${share.uuid}`, { method: 'DELETE' });
  }

  /** The node's live links as filex reports them. `uuid` is the share id in string form — there is no `id` key. */
  private async shares(id: string): Promise<{ uuid: string; url: string }[]> {
    try {
      const { shares } = await request<{ shares: { uuid: string; url: string }[] }>('/api/files/share', { query: { path: id } });
      return shares ?? [];
    } catch (error) {
      // Below editor filex refuses the question rather than answering "none"; to the panel that is the same thing.
      if (error instanceof HttpError && error.status === 403) return [];
      throw error;
    }
  }

  async recordOpen(id: string): Promise<void> {
    await request(`${MANAGER}/recent`, { method: 'POST', body: { node_id: this.nodeId(id) } });
  }

  // ── access, history ─────────────────────────────────────────────────────────

  async listPeople(nodeId: string): Promise<Access> {
    const { direct, inherited, can_manage } = await request<{ direct: WireGrant[]; inherited: WireGrant[]; can_manage?: boolean }>(
      '/api/files/permissions',
      { query: { path: nodeId } },
    );
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
    return { people, canManage: can_manage ?? false };
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
    const rows = [...(versions ?? [])].sort((a, b) => b.version_n - a.version_n);
    // An unattributed revision stays unattributed. Stamping the reader's own name on it, which is what this did
    // before the column existed, told everyone they had written every version of every file they opened.
    return rows.map((v, i) => ({
      id: String(v.id),
      at: v.created_at,
      size: v.size,
      ...(v.created_by === undefined ? {} : { authorId: String(v.created_by), authorName: v.author_name }),
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
  /**
   * What has happened to one file. filex records an event for every write, so the feed is real from the moment the
   * server is upgraded — but only from then: the events already in the table predate the columns that make them
   * findable per node, and no backfill invents a history nobody could read.
   *
   * Events the app has no sentence for are dropped rather than shown as something they are not.
   */
  async listActivity(nodeId: string): Promise<ActivityEvent[]> {
    const { events } = await request<{ events: WireActivityEvent[] }>('/api/files/activity', { query: { path: nodeId } });
    const storageName = nodeId.slice(0, Math.max(0, nodeId.indexOf('://')));
    return events.map((event) => fromActivityEvent(event, storageName)).filter((event): event is ActivityEvent => event !== null);
  }

  /** Everyone seen owning a row so far, and the account itself — which owns things whether or not it has listed any. */
  async listFilterPeople(): Promise<Person[]> {
    const me = await this.currentUser();
    const options = new Map(this.people);
    options.set(me.id, { id: me.id, name: me.name, initial: me.initial, role: 'owner' });
    return [...options.values()];
  }

  // ── search ──────────────────────────────────────────────────────────────────

  /**
   * The date window, the type group, the size band, the owner and the current-folder scope are now the server's
   * work: it resolves them against the node table and restricts the index to what they matched, so a filtered
   * search no longer means "the first hundred hits for the text, minus the ones that did not fit". What stays here
   * is the custom size range the form allows but the presets do not express, and whole-phrase/case/OCR, which
   * filex's query language has no form of.
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const scope = query.scope === 'content' ? 'content' : query.scope === 'paths' ? 'path' : '';
    // "Whole phrase" is sent the way every search box in the world spells it: the text in quotes. The server reads a
    // fully quoted query as a phrase INSIDE files; filename matching drops the quotes and stays subsequence-based,
    // because `invoice 2026` has to keep finding `invoice_2026.pdf`. The tag terms stay outside the quotes.
    const phrase = query.wholePhrase ? quoted(query.text) : query.text;
    const text = query.tags.length ? [phrase, ...query.tags.map((t) => `tag:${t}`)].join(' ').trim() : phrase;
    // POST rather than the GET form: the facets are a list and four numbers, and the body is where filex's search
    // has always taken them. No storage_id — the app addresses drives by name and has no numeric one to send, so
    // the server asks every drive the caller could see and lets its own RBAC pass decide what comes back.
    const { results } = await request<{ results: (WireNode & { snippet?: string })[] }>('/api/files/search', {
      method: 'POST',
      body: { query: text, limit: SEARCH_LIMIT, ...(scope ? { scope } : {}), ...searchFacets(query) },
    });
    const hits: SearchHit[] = [];
    for (const row of results) {
      if (!row.storage) continue;
      const node = { ...fromModelNode(row, row.storage), ownerId: this.owner() };
      this.remember(node.id, row.id);
      // Only what the server could not express: a hand-typed size range.
      if (query.size.preset === 'custom' && !withinCustomSize(node, query.size)) continue;
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



  /**
   * One turn, streamed. The scope chip goes with the question: the server turns it into one sentence of guidance for
   * that turn only — it is not stored with the question and not replayed, the same way the chip is not sticky on
   * screen.
   *
   * `hits` arrives whenever the assistant ran a search: the same rows the model reads as JSON, for the panel to draw
   * as cards. They are stored with the answer, so reopening the conversation redraws them.
   */
  async *assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal): AsyncIterable<AssistantEvent> {
    if (!conversationId) throw new Error('assistant: a conversation has to exist before a turn can be stored in it');
    const stream = streamJSON<WireAssistantEvent>(`${ASSISTANT_SESSIONS}/${conversationId}/turn`, { prompt, mode }, signal);
    for await (const event of stream) {
      if (event.type === 'meta') yield { type: 'meta', conversationId: event.conversation_id ?? conversationId };
      else if (event.type === 'text') yield { type: 'text', delta: event.delta ?? '' };
      else if (event.type === 'tool') yield { type: 'tool', tool: event.tool ?? '', target: event.target };
      else if (event.type === 'card') {
        const card = fromCard(event as WireCard);
        if (card) yield { type: 'card', card };
      }
      else if (event.type === 'hits' && event.hits?.length) yield { type: 'hits', hits: event.hits.map(fromAssistantHit) };
      else if (event.type === 'title' && event.title) yield { type: 'title', title: event.title };
      else if (event.type === 'error') yield { type: 'error', message: event.message ?? '' };
      else if (event.type === 'done') yield { type: 'done' };
    }
  }

  /**
   * Whether this server can answer at all. A filex with no model provider configured says so, and the panel is not
   * offered — a chat box that could only fail is worse than none. An older server has no such route, which is the
   * same answer.
   */
  private async assistantEnabled(): Promise<boolean> {
    try {
      const { enabled } = await request<{ enabled?: boolean }>(ASSISTANT_STATUS);
      return enabled === true;
    } catch {
      return false;
    }
  }

  // ── assistant history ───────────────────────────────────────────────────────

  async listAssistantSessions(): Promise<AssistantSession[]> {
    const { sessions } = await request<{ sessions: WireChatSession[] }>(ASSISTANT_SESSIONS);
    return (sessions ?? []).map(fromChatSession);
  }

  async createAssistantSession(title?: string): Promise<AssistantSession> {
    const { session } = await request<{ session: WireChatSession }>(ASSISTANT_SESSIONS, {
      method: 'POST',
      body: title === undefined ? {} : { title },
    });
    return fromChatSession(session);
  }

  async assistantMessages(id: string): Promise<AssistantConversation> {
    const { messages, granted } = await request<{ messages: WireChatMessage[]; granted?: string[] }>(`${ASSISTANT_SESSIONS}/${id}`);
    return {
      messages: (messages ?? []).map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        text: m.content,
        at: m.created_at,
        ...(m.aborted ? { aborted: true } : {}),
        ...(m.cards?.length ? { cards: m.cards.map(fromCard).filter((c): c is AssistantCard => c !== null) } : {}),
        ...(m.hits?.length ? { hits: m.hits.map(fromAssistantHit) } : {}),
      })),
      granted: granted ?? [],
    };
  }

  /** One path, one permission. The server takes no other shape of this call. */
  async approveAssistantRead(id: string, path: string): Promise<void> {
    await request(`${ASSISTANT_SESSIONS}/${id}/approvals`, { method: 'POST', body: { path } });
  }

  /** The body is empty on purpose: the work is the plan the server already stored, not anything sent from here. */
  async decideAssistantPlan(id: string, planId: string, approve: boolean): Promise<PlanOutcome> {
    const verb = approve ? 'approve' : 'cancel';
    const wire = await request<{ status: string; items?: WirePlanResult[]; done?: number; skipped?: number; failed?: number }>(
      `${ASSISTANT_SESSIONS}/${id}/plans/${planId}/${verb}`,
      { method: 'POST', body: {} },
    );
    return {
      status: wire.status === 'cancelled' ? 'cancelled' : 'done',
      results: (wire.items ?? []).map(fromPlanResult),
      done: wire.done ?? 0,
      skipped: wire.skipped ?? 0,
      failed: wire.failed ?? 0,
    };
  }

  async renameAssistantSession(id: string, title: string): Promise<AssistantSession> {
    const { session } = await request<{ session: WireChatSession }>(`${ASSISTANT_SESSIONS}/${id}`, { method: 'PATCH', body: { title } });
    return fromChatSession(session);
  }

  async deleteAssistantSession(id: string): Promise<void> {
    await request(`${ASSISTANT_SESSIONS}/${id}`, { method: 'DELETE' });
  }
}
