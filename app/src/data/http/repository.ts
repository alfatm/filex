import { ACCOUNT_DISABLED, DUPLICATE_NAME, FileLimitExceeded, FORBIDDEN, INVALID_CODE, INVALID_NAME, INVALID_CREDENTIALS, NOT_FOUND, OPERATION_PENDING, QuotaExceeded, RBAC_DISABLED, ROLE_FORBIDDEN, SIGN_IN_LIMITED, TOTP_REQUIRED, UploadConflict, UploadRateLimited, WRONG_PASSWORD, type Repository } from '../repository';
import { windowBounds } from '../dateWindow';
import { MODIFIED_WINDOW_DAYS, SIZE_PRESET_BYTES, TYPE_GROUPS } from '../listingFilter';
import { extensionsOf } from '../fileTypes';
import { noCapabilities, ROLE_PERMISSIONS, type Access, type ActivityEvent, type AssistantCard, type AssistantContext, type AssistantConversation, type AssistantMessage, type AssistantMode, type AssistantReport, type PlanDecision, type PlanOutcome, type PlanResult, type AssistantSession, type AssistantEvent, type AuthMethods, type AuthOptions, type Branding, type Capabilities, type FolderListing, type GroupOption, type InviteOutcome, type ListingFilter, type Node, type Person, type Quota, type RolePermission, type Credentials, type ProfilePatch, type SearchHit, type SearchQuery, type NotifyPrefs, type SearchResult, type Session, type Storage, type TotpEnrollment, type UploadInput, type UploadOptions, type UploadSession, type User, type Version } from '../types';
import { i18n } from '@/i18n';
import { isInside, joinPath, nameOf, parentPath, splitPath } from '@/lib/address';
import { HttpError, putChunk, request, streamJSON } from './client';
import {
  fromFileNode,
  fromActivityEvent,
  fromModelNode,
  fromSnippet,
  fromTrashEntry,
  SELF,
  toQuota,
  toStorage,
  type WireFileNode,
  type WireIndex,
  type WireNode,
  type WireOp,
  type WireQuota,
  type WireStorage,
  type WireAuthMethods,
  type WireTotpEnrollment,
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
  previewUrl,
  downloadUrl,
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

/** What filex ships with (`model.MaxAssistantSessions`), used only until the first session listing states its own. */
const DEFAULT_ASSISTANT_SESSION_MAX = 100;

/** How many groups the invite row's picker asks for; it is a type-ahead, not a directory. */
const GROUP_PICKER_LIMIT = 20;

const NOTIFY_SETTINGS = '/api/notifications/settings';
const ASSISTANT_SESSIONS = '/api/assistant/sessions';
const ASSISTANT_STATUS = '/api/assistant/status';

/** One frame of the turn stream; filex carries the kind inside the payload rather than on an `event:` line. */
interface WireAssistantEvent {
  type: 'meta' | 'text' | 'tool' | 'card' | 'hits' | 'report' | 'title' | 'error' | 'done';
  conversation_id?: string;
  delta?: string;
  message?: string;
  /** `error`: "quota" or "unavailable" when the failure is one the person can act on; absent otherwise. */
  code?: string;
  /** `title`: the name the server gave this conversation. */
  title?: string;
  /** `hits`: what a search found, for the panel's result cards. */
  hits?: WireAssistantHit[];
  /** `report`: a document a tool wrote for the person. */
  report?: WireReport;
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
  /** Only the share-link kind produces one. */
  url?: string;
}

/** A document a tool wrote for the person: its rows are search-result rows, so the same mapping draws them. */
interface WireReport {
  title?: string;
  text?: string;
  rows?: WireAssistantHit[];
}

function fromReport(wire: WireReport): AssistantReport {
  return { title: wire.title ?? '', ...(wire.text ? { text: wire.text } : {}), rows: (wire.rows ?? []).map(fromAssistantHit) };
}

/** A stored card, as the messages endpoint redraws it — a plan is hydrated from the plan row, not from the message. */
interface WireCard {
  kind: string;
  path?: string;
  reason?: string;
  /** `approval`: how it ended, once it has. */
  decision?: string;
  plan_id?: string;
  plan_kind?: string;
  summary?: string;
  status?: string;
  items?: WirePlanItem[];
  results?: WirePlanResult[];
}

function fromPlanResult(wire: WirePlanResult): PlanResult {
  const state = wire.state === 'done' || wire.state === 'skipped' ? wire.state : 'failed';
  return {
    path: wire.path,
    state,
    ...(wire.code ? { code: wire.code } : {}),
    ...(wire.reason ? { reason: wire.reason } : {}),
    ...(wire.url ? { url: wire.url } : {}),
  };
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
  if (wire.kind === 'approval') {
    const decision = wire.decision === 'allowed' || wire.decision === 'denied' || wire.decision === 'expired' ? wire.decision : undefined;
    return { kind: 'approval', path: wire.path ?? '', reason: wire.reason, ...(decision ? { decision } : {}) };
  }
  return null;
}

/**
 * One stored turn as the panel holds it. `system` is kept as itself: it is the executor's line about a plan, drawn
 * as a side of its own, and reading it as an assistant answer would put the server's words in the model's mouth.
 */
function fromChatMessage(wire: WireChatMessage): AssistantMessage {
  const role = wire.role === 'user' || wire.role === 'system' ? wire.role : 'assistant';
  return {
    id: wire.id,
    role,
    text: wire.content,
    at: wire.created_at,
    ...(wire.aborted ? { aborted: true } : {}),
    ...(wire.cards?.length ? { cards: wire.cards.map(fromCard).filter((c): c is AssistantCard => c !== null) } : {}),
    ...(wire.hits?.length ? { hits: wire.hits.map(fromAssistantHit) } : {}),
    ...(wire.reports?.length ? { reports: wire.reports.map(fromReport) } : {}),
    ...(wire.plan_decision ? { planDecision: fromPlanDecision(wire.plan_decision) } : {}),
  };
}

function fromPlanDecision(wire: WirePlanDecision): PlanDecision {
  return {
    planId: wire.plan_id,
    status: wire.status === 'cancelled' ? 'cancelled' : 'done',
    done: wire.done ?? 0,
    skipped: wire.skipped ?? 0,
    failed: wire.failed ?? 0,
  };
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

/** `GET /api/branding`; the two footer fields it also carries have no home in this app. */
interface WireBranding {
  name?: string;
  logo_url?: string;
  accent?: string;
}

const UPLOAD = '/api/files/upload';
/**
 * Staged uploads (docs/UPLOADS.md): `begin` opens a session, each `PUT` carries one chunk and answers with the
 * offset the server now holds, `commit` turns the staging area into a node. The chunk size the server hands back
 * is binding; this is only what to ask for, and what to fall back on if it says nothing.
 *
 * 1 MiB rather than the server's 8 MiB default, because the chunk is also the resolution of the progress bar and
 * the unit a failure costs: at 8 MiB most documents would be one chunk, and their bar would only ever read 0 or
 * 100. The extra round trips are cheap next to the bytes they carry.
 */
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
/** The server's own maximum for `shared-with-me`; the facets go in the query, so the page is the filtered set. */
const SHARED_LIMIT = 500;
const SEARCH_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_UNIT_BYTES = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;

/**
 * Where a search is confined: a drive, and a folder inside it — or `null` for "nowhere it could match".
 *
 * Two controls say this, and they can both be set. The Path box names a drive and a folder in the FULL address
 * space (`/demo/design/`), because that is what a person sees in the breadcrumb; the server's `path_prefix` is
 * relative to the storage, so the drive comes off here. The "current folder" scope names a folder without a drive.
 * Both are subtrees, so setting both means the deeper of the two — unless neither contains the other, and then
 * they contradict and nothing can satisfy both. That is an answer, not a failure, and it costs no request.
 */
function searchConfine(query: SearchQuery): { drive?: string; prefix: string } | null {
  // In `skip` mode the box names the folder to LEAVE OUT, so it confines nothing: it travels as a `-path:`
  // exclusion instead (see searchExclusions). Reading it here too would confine the search to the one folder the
  // user asked to be rid of.
  const typed = query.pathMode === 'skip' ? [] : query.path.split('/').filter(Boolean);
  const scoped = query.searchIn === 'current' ? query.folderPath.split('/').filter(Boolean) : [];
  if (!typed.length) return { prefix: scoped.join('/') };
  const [drive, ...under] = typed;
  if (!scoped.length) return { drive, prefix: under.join('/') };
  const [deep, shallow] = under.length >= scoped.length ? [under, scoped] : [scoped, under];
  if (shallow.some((part, i) => part !== deep[i])) return null;
  return { drive, prefix: deep.join('/') };
}

/**
 * The Path box in `skip` mode, as the query-language terms that carry it.
 *
 * The first segment is a DRIVE, exactly as searchConfine reads it — the box names a folder in the full address
 * space, because that is what the breadcrumb shows. The drive is not part of a node's stored path, so only the
 * segments below it become the `-path:` exclusion; a box naming nothing but a drive excludes no folder and is
 * sieved by name with the hits instead (see `skipDrive`).
 */
function searchExclusions(query: SearchQuery): { terms: string[]; skipDrive?: string } {
  // The chips first: they are already storage-relative, because they were taken off a hit.
  const terms = query.excludePaths.map(pathExcludeTerm).filter(Boolean);
  if (query.pathMode !== 'skip') return { terms };
  const [drive, ...under] = query.path.split('/').filter(Boolean);
  if (!drive) return { terms };
  if (!under.length) return { terms, skipDrive: drive };
  return { terms: [...terms, pathExcludeTerm(under.join('/'))].filter(Boolean), skipDrive: drive };
}

/** One storage-relative folder as the `-path:` term that carries it, or "" when there is no folder in it. */
function pathExcludeTerm(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  if (!parts.length) return '';
  const folder = parts.join(' ');
  // Quoted whenever it is more than one segment, for the same reason a tag with a space is: the server splits a
  // query on whitespace before it reads an operator.
  return `-path:${parts.length > 1 ? `"${folder}"` : folder}`;
}

/**
 * The advanced form as request fields. Extensions rather than a group name, because which extensions count as
 * "documents" is the app's word and `extensionsOf` is where it is kept — the server holds no second copy of it.
 */
function searchFacets(query: SearchQuery, confine: { prefix: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `searchIn`, not `scope`: the scope picks which FIELDS are consulted, this picks WHERE.
  if (confine.prefix) out.path_prefix = `/${confine.prefix}`;
  if (query.fileType !== 'any') out.ext = extensionsOf(TYPE_GROUPS[query.fileType]);
  if (query.modified !== 'any') out.modified_after = Date.now() - MODIFIED_WINDOW_DAYS[query.modified] * DAY_MS;
  if (query.around) {
    const { after, before } = windowBounds(query.around);
    if (query.around.field === 'modified') {
      out.modified_after = after;
      out.modified_before = before;
    } else {
      out.created_after = after;
      out.created_before = before;
    }
  }
  if (query.size.preset === 'custom') {
    // A hand-typed range is bytes after a multiplication, which is exactly what the server takes. It used to be
    // sieved out of the answer instead, so past the hit limit it narrowed a WINDOW rather than the search.
    const unit = SIZE_UNIT_BYTES[query.size.unit] ?? 1;
    if (query.size.min !== null) out.size_min = query.size.min * unit;
    if (query.size.max !== null) out.size_max = query.size.max * unit;
  } else if (query.size.preset !== 'any') {
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
  // A window around one row's date, as its two edges. The Modified chip writes `modified_after` too, but the two
  // cannot both be set: picking either clears the other, since one column cannot answer two windows at once.
  if (filter.around) {
    const { after, before } = windowBounds(filter.around);
    if (filter.around.field === 'modified') {
      out.modified_after = after;
      out.modified_before = before;
    } else {
      out.created_after = after;
      out.created_before = before;
    }
  }
  // Comma-joined like `ext`, and AND like the server reads it: a row has to carry every tag listed.
  if (filter.tags.length) out.tag = filter.tags.join(',');
  if (filter.mime) out.mime = filter.mime;
  const owner = Number(filter.personId);
  if (filter.personId && Number.isFinite(owner)) out.owner_id = owner;
  if (filter.name.trim()) out.name = filter.name.trim();
  return out;
}

/**
 * Who shared a row and when, as the Shared-with-me columns print them.
 *
 * The display NAME only. filex withholds the granter's e-mail on purpose — this is the one listing whose whole
 * purpose is to show one account's details to another — so an account that has set no name is a neutral
 * placeholder here rather than the address it signs in with.
 */
function granter(wire: WireFileNode | undefined): Pick<Node, 'sharedBy' | 'sharedAt'> {
  if (!wire) return {};
  return {
    ...(wire.shared_by === undefined ? {} : { sharedBy: wire.shared_by_name || i18n.global.t('files.sharedByUnknown') }),
    ...(wire.shared_at === undefined ? {} : { sharedAt: new Date(wire.shared_at).toISOString() }),
  };
}

/**
 * `SearchScope` → `search.ParseScope`. "All" is the server's default, so it is sent as nothing at all; `paths` is
 * the server's alias of the name scope (a name plus the whole address, never the contents), and `tags` is answered
 * from `node_meta` rather than from the index.
 */
const SEARCH_SCOPES_WIRE: Record<SearchQuery['scope'], string> = { all: '', content: 'content', paths: 'path', tags: 'tags' };

/** The text as one phrase, with any quotes of its own removed — a stray one would make the whole form unreadable. */
function quoted(text: string): string {
  const inner = text.replaceAll('"', ' ').trim();
  return inner ? `"${inner}"` : '';
}

/**
 * The 409 that really is a taken name, and only that.
 *
 * filex answers 409 on more than a collision — a move that crosses an encryption boundary, a staged upload whose
 * session is no longer in the state the call assumes — and every one of those used to reach the user as "a file
 * with this name already exists", which is a sentence about the wrong thing. So the translation belongs to the two
 * verbs where a 409 has one meaning: creating a folder and renaming. Everything else keeps the server's own error.
 */
function asDuplicateName(error: unknown): never {
  if (error instanceof HttpError && error.status === 409) throw new Error(DUPLICATE_NAME);
  // These three verbs send nothing a server can call malformed except the name, so a 400 IS a refused name.
  // Without this the modal fell through to the server's own sentence ("400: bad folder name").
  if (error instanceof HttpError && error.status === 400) throw new Error(INVALID_NAME);
  // A new file is a write like an upload is, so it meets the same two quota refusals; `asQuotaRefusal` ends at the
  // role one, which is the third thing any of these three verbs can be told.
  return asQuotaRefusal(error);
}

/** The two 409s of the staged upload that are about the TARGET, told apart by the body's `code`; every other error stands. */
function asUploadConflict(error: unknown, phase: UploadConflict['phase'], sessionId: string | null): never {
  if (error instanceof HttpError && error.status === 409) {
    const code = codeOf(error);
    if (code === 'EXISTS') throw new UploadConflict('exists', phase, sessionId);
    if (code === 'UPLOAD_IN_PROGRESS') throw new UploadConflict('inProgress', phase, sessionId);
  }
  return asQuotaRefusal(error);
}

/** The `code` a filex refusal names itself with, or "" when the body carries none. */
function codeOf(error: HttpError): string {
  return typeof error.body === 'object' && error.body !== null && 'code' in error.body ? String((error.body as { code: unknown }).code) : '';
}

/** A number off a refusal's body, when the server put one there. */
function numberOf(error: HttpError, field: string): number | null {
  const body = error.body;
  if (typeof body !== 'object' || body === null || !(field in body)) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : null;
}

/**
 * The 403 that is about the caller's ROLE rather than about the node.
 *
 * Told apart by the body's `code`, exactly as the upload's two 409s are: an ordinary "you may not touch this file"
 * still reaches the caller as the server's own sentence, and only `ROLE_FORBIDDEN` becomes the sentinel the UI
 * answers with "Your role may not do this".
 */
function asRoleForbidden(error: unknown): never {
  if (error instanceof HttpError && error.status === 403 && codeOf(error) === 'ROLE_FORBIDDEN') throw new Error(ROLE_FORBIDDEN);
  throw error;
}

/**
 * How long a rate-limited upload waits when nothing said how long: neither `retry_after_seconds` in the body nor a
 * readable `Retry-After` header. Short, because it is a guess, but never zero.
 */
const RETRY_AFTER_FALLBACK_SECONDS = 5;

/**
 * The three quota refusals an upload (or a new file) can meet, plus the role one.
 */
function asQuotaRefusal(error: unknown): never {
  if (error instanceof HttpError) {
    const code = codeOf(error);
    // The account is full. Nothing per-file is wrong and waiting will not help, so this is a failure with a reason
    // — it used to fall through to the generic HTTP error and reach the tray as a bare "Upload failed".
    if (error.status === 413 && code === 'QUOTA_EXCEEDED') throw new QuotaExceeded();
    if (error.status === 413 && code === 'FILE_LIMIT_EXCEEDED') {
      throw new FileLimitExceeded(numberOf(error, 'limit') ?? 0, numberOf(error, 'used') ?? 0);
    }
    if (error.status === 429 && code === 'UPLOAD_RATE_LIMITED') {
      // The body states it; the `Retry-After` header is the fallback, for a proxy that answers before filex does.
      // ⚠ An ABSENT header must not decode as a wait of zero — `Number(null)` and `Number('')` are both 0, which
      // is finite, and a row that "waits" 0 s re-sends at once into the refusal it just met. A proxy that answers
      // with neither the body field nor the header is exactly the case this fallback exists for, so an
      // unreadable wait becomes the minimum below rather than no wait at all.
      const header = error.headers?.get('retry-after');
      const seconds = header === null || header === undefined ? NaN : Number(header);
      throw new UploadRateLimited(
        numberOf(error, 'retry_after_seconds') ?? (Number.isFinite(seconds) && seconds > 0 ? seconds : RETRY_AFTER_FALLBACK_SECONDS),
      );
    }
  }
  return asRoleForbidden(error);
}

/**
 * Every MUTATING call goes through this rather than through `request`: a refusal the caller's role earned is not
 * the same event as a refusal the node earned, and only one of the two is worth telling somebody to ask an
 * administrator about.
 */
function write<T>(path: string, options: Parameters<typeof request>[1]): Promise<T> {
  return request<T>(path, options).catch(asRoleForbidden);
}

/** `acl.Level` ↔ the roles the access modal offers. filex has no fourth level, so the mapping is total. */
const LEVELS: Record<string, Person['role']> = { owner: 'owner', editor: 'editor', viewer: 'viewer' };

interface WireGrant {
  id: number;
  /** Absent on a group row, which carries `group_id` instead. Older servers send no `principal` and only users. */
  principal?: 'user' | 'group';
  user_id?: number;
  level: string;
  user_email?: string;
  user_display_name?: string;
  group_id?: number;
  group_name?: string;
  member_count?: number;
  inherited?: boolean;
}

/** One row of `GET /api/files/permissions/groups`. */
interface WireGroup {
  id: number;
  name: string;
  member_count?: number;
}

/** What an invite did, and — when nobody had an account — the public link filex minted instead. */
interface WireInvite {
  mode?: InviteOutcome['mode'];
  url?: string;
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

/**
 * Which of the four sign-in refusals this is.
 *
 * Anything that is not one of them — a 500, a proxy's HTML error page, a dropped connection — is reported as bad
 * credentials only if the server said 401/403; otherwise the transport error is what the form should show, so it
 * is re-raised by the caller under its own message.
 */
function refusalOf(error: unknown): string {
  if (!(error instanceof HttpError)) throw error;
  const body = (error.body ?? {}) as WireLoginRefusal;
  if (body.disabled) return ACCOUNT_DISABLED;
  if (body.maintenance) return SIGN_IN_LIMITED;
  if (body.totp_required) return TOTP_REQUIRED;
  if (error.status === 401 || error.status === 403) return INVALID_CREDENTIALS;
  throw error;
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
  /** The documents the tools wrote for the person in this turn, stored with the answer. */
  reports?: WireReport[];
  /** On a system message: what the executor did about one plan. */
  plan_decision?: WirePlanDecision;
}

interface WirePlanDecision {
  plan_id: string;
  status: string;
  done?: number;
  skipped?: number;
  failed?: number;
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

/**
 * The pre-session half of `model.Capabilities`.
 *
 * Read from `/api/capabilities`, which is public — the same handler as `/api/files/capabilities`, but asked for
 * without the assistant probe beside it, because that one needs a session and a visitor at the sign-in screen has
 * none.
 */
interface WireAuthOptions {
  auth_drivers?: string[];
  oidc_auto_redirect?: boolean;
  version?: string;
}

/** The body filex answers a refused sign-in with; the status alone cannot tell the four refusals apart. */
interface WireLoginRefusal {
  totp_required?: boolean;
  disabled?: boolean;
  maintenance?: boolean;
}

/** `model.Capabilities` — only the fields the app gates on. */
interface WireCapabilities {
  /** The caller's ROLE permissions. Absent on a server too old to report them — see `capabilities`. */
  permissions?: string[];
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
  /**
   * `<node path>|<person id>` → the grant row, which is what PATCH and DELETE address. The principal is kept with
   * it because those two verbs need `?principal=group` for a group's grant and nothing in the id space says so on
   * its own — `g:` is this repository's own prefix, not the server's.
   */
  private readonly grants = new Map<string, { id: number; principal: 'user' | 'group' }>();
  /**
   * Numeric ids of the nodes this session put in the trash. `ids` has to forget the path — it is free again, and a
   * new node may take it — but `restore` addresses the trashed row by number, and Undo restores without ever
   * listing the trash first.
   */
  private readonly trashed = new Map<string, number>();
  private storages: Storage[] | null = null;
  private user: User | null = null;
  /** The conversation ceiling the last session listing reported; see `assistantSessionMax`. */
  private assistantMax = DEFAULT_ASSISTANT_SESSION_MAX;

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

  /**
   * Forgets a node's number AND every number remembered under it.
   *
   * An address is a path, so a folder that was renamed, moved or trashed took its whole subtree with it. Dropping
   * only the folder's own entry left the children filed under addresses nothing lives at any more — and the next
   * star, tag or version call for one of those paths would send the number of a node that is now somewhere else.
   */
  private forget(path: string): void {
    this.ids.delete(path);
    for (const known of [...this.ids.keys()]) {
      if (isInside(known, path)) this.ids.delete(known);
    }
  }

  /**
   * Drops the cached drive list. It carries what each drive HOLDS, so every byte written or freed makes it wrong:
   * cached for the session, the quota bar in the sidebar and on the drive cards never moved again after start-up.
   */
  private forgetStorages(): void {
    this.storages = null;
  }

  private project(rows: WireFileNode[]): Node[] {
    return rows.map((row) => {
      this.remember(row.path, row.id);
      return this.owned(fromFileNode(row), row.owner_id !== undefined);
    });
  }

  /**
   * A row's owner, kept or fallen back on — and learned, for the People chip.
   *
   * `named` is whether filex actually said who owns it. When it did not (anything a storage sync found rather than
   * a person uploading it) the caller is the honest answer, because everything they can see, they can see. When it
   * DID, overwriting it with the caller is a false statement about who put the file there — which is what the flat
   * listings used to do, so starred, recent and search all said "You" over somebody else's file on a shared drive.
   */
  private owned(node: Node, named: boolean): Node {
    if (!named) return { ...node, ownerId: this.owner() };
    if (!this.people.has(node.ownerId)) {
      this.people.set(node.ownerId, { id: node.ownerId, name: node.ownerName ?? node.ownerId, initial: initialOf(node.ownerName ?? '?'), role: 'owner', principal: 'user' });
    }
    return node;
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
      out.push(this.owned(node, row.owner_id !== undefined));
    }
    return out;
  }

  private index(path: string, facets: Record<string, string | number | undefined> = {}): Promise<WireIndex> {
    return request<WireIndex>(MANAGER, { query: { q: 'index', path, ...facets } });
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
    const account: Quota = toQuota(quota);
    this.storages = storages.map((s) => toStorage(s, account));
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
   * The session behind this browser's cookie, or null when there is none.
   *
   * The one place a 401 is read as an answer rather than as a failure — which is also why it asks the server
   * every time instead of going through `currentUser`'s cache: it is the question "does this cookie still work",
   * and a remembered answer cannot say. The router's guard wants to know WHICH kind of no, so that a server that
   * is merely down does not look like a sign-out and throw the person at the form with their work behind it.
   */
  async session(): Promise<User | null> {
    try {
      const { user } = await request<{ user: WireUser }>('/api/auth/me', { expectUnauthorized: true });
      this.user = toUser(user);
      return this.user;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        this.user = null;
        return null;
      }
      throw error;
    }
  }

  /**
   * Signs in against the local realm.
   *
   * filex answers a wrong password, a missing second factor and a wrong second factor with the same 401 — on
   * purpose, so an anonymous caller learns nothing — and marks the two TOTP cases in the BODY, which is the only
   * thing that lets the form ask for a code instead of saying the password was wrong. A disabled account and a
   * locked-down tenant come back as 403 with their own markers.
   */
  async signIn(credentials: Credentials): Promise<User> {
    try {
      const { user } = await request<{ user: WireUser }>('/api/auth/login', {
        method: 'POST',
        expectUnauthorized: true,
        body: {
          email: credentials.identifier,
          password: credentials.password,
          totp: credentials.totp ?? '',
          remember: credentials.remember ?? false,
        },
      });
      // The answer IS the account, so the cache the rest of the app reads is filled here rather than by a second
      // round trip to /api/auth/me on the first screen after the form.
      this.user = toUser(user);
      return this.user;
    } catch (error) {
      throw new Error(refusalOf(error));
    }
  }

  /**
   * Ends the session. The cached account goes with it — this instance outlives the sign-out (the app reloads
   * itself onto the form rather than tearing down the module), and a stale `this.user` would answer `session()`
   * for the person who just left.
   */
  async signOut(): Promise<void> {
    try {
      // A sign-out of a session the server has already dropped is a 401, and it is the one 401 that must not be
      // announced: the person is on their way out, and the app is about to leave the page anyway.
      await request('/api/auth/logout', { method: 'POST', expectUnauthorized: true });
    } catch (error) {
      // A server that could not be told is still a browser that is done with this account: the cookie is cleared
      // by the reload that follows, and refusing to sign out because the network blinked leaves the person
      // looking at somebody else's files.
      console.error('sign-out failed server-side', error);
    } finally {
      this.user = null;
    }
  }

  async authOptions(): Promise<AuthOptions> {
    // The sign-in screen asks this BEFORE anybody is signed in, and filex refuses a visitor: its 401 is the state
    // of the caller, not of a session, and reporting it raised "your session has ended" on the sign-in form.
    const wire = await request<WireAuthOptions>('/api/capabilities', { expectUnauthorized: true });
    return {
      drivers: wire.auth_drivers ?? [],
      oidcAutoRedirect: wire.oidc_auto_redirect === true,
      version: wire.version ?? '',
    };
  }

  /**
   * The IdP hand-off. `return_to` is honoured by the callback since the end-user app grew a sign-in of its own —
   * before that every SSO login bounced to `/admin/`, which is not where an ordinary account belongs.
   */
  oidcStartUrl(returnTo: string): string {
    return `/api/auth/oidc/start?${new URLSearchParams({ provider: 'oidc', return_to: returnTo }).toString()}`;
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

  previewUrl(id: string): string | undefined {
    return previewUrl(id);
  }

  downloadUrl(id: string): string | undefined {
    return downloadUrl(id);
  }

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

  /** filex checks the old password itself and answers 401 when it is wrong; every other status is a real failure. */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await request('/api/auth/password', {
        method: 'POST',
        body: { old_password: currentPassword, new_password: newPassword },
        expectUnauthorized: true,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) throw new Error(WRONG_PASSWORD);
      throw error;
    }
  }

  async totpEnroll(): Promise<TotpEnrollment> {
    const wire = await request<WireTotpEnrollment>('/api/auth/totp/enroll', { method: 'POST' });
    return { secret: wire.secret, otpauthUrl: wire.otpauth_url, qrSvg: wire.qr_svg, recoveryCodes: wire.recovery_codes ?? [] };
  }

  /** A 401 here is the code being wrong, not the session having ended — the same reading as `changePassword`. */
  async totpVerify(code: string): Promise<void> {
    try {
      await request('/api/auth/totp/verify', { method: 'POST', body: { code }, expectUnauthorized: true });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) throw new Error(INVALID_CODE);
      throw error;
    }
  }

  /**
   * Both refusals come back as a 401, so the server's own words are what tells the password apart from the code:
   * `password incorrect` is the one it checks first, anything else refused is the code.
   */
  async totpDisable(password: string, code: string): Promise<void> {
    try {
      await request('/api/auth/totp/disable', { method: 'POST', body: { password, code }, expectUnauthorized: true });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        const detail = typeof error.body === 'object' && error.body !== null && 'error' in error.body ? String((error.body as { error: unknown }).error) : '';
        throw new Error(detail === 'password incorrect' ? WRONG_PASSWORD : INVALID_CODE);
      }
      throw error;
    }
  }

  /**
   * filex reports what the STORAGE DRIVERS can do; the rest of the block names features it has endpoints for but
   * does not advertise — zipping a subtree, purging the trash, the per-node activity feed, tags, permissions and
   * the connection screens are filex's own work rather than a driver's, and each is noted below. The assistant is
   * the one that is asked about rather than assumed: `/api/assistant/status` says whether this install has one.
   */
  async capabilities(): Promise<Capabilities> {
    const [wire, assistant] = await Promise.all([request<WireCapabilities>('/api/files/capabilities'), this.assistantEnabled()]);
    return {
      ...noCapabilities(),
      // ⚠ A server too old to report role permissions is read as granting ALL of them. Reading it as "none" would
      // empty every menu on the first install that upgrades the app before the backend — the flag says what a role
      // may NOT do, and a server that has no such rule has nothing to withhold.
      allowed: new Set<RolePermission>(wire.permissions ? (wire.permissions as RolePermission[]).filter((id) => ROLE_PERMISSIONS.includes(id)) : ROLE_PERMISSIONS),
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
      // `/api/tokens` and the guides' own endpoints are mounted unconditionally and open to every account.
      connections: true,
    };
  }

  /**
   * The operator's branding. Public and pre-session on the server — the admin login page reads it before anyone
   * has signed in — so it is asked for like anything else and simply comes back empty on an unbranded install.
   *
   * `footer_text` and `hide_powered_by` are ignored: they dress the public share and drop pages, and this app is
   * the signed-in surface, which has no footer to put them in.
   */
  async branding(): Promise<Branding> {
    const wire = await request<WireBranding>('/api/branding');
    return { name: wire.name ?? '', logoUrl: wire.logo_url ?? '', accent: wire.accent ?? '' };
  }

  // ── the folder tree ─────────────────────────────────────────────────────────

  async listFolder(folderId: string, filter?: ListingFilter): Promise<FolderListing> {
    const { files, total } = await this.index(folderId, listingFacets(filter));
    // A server from before the facets answers no `total`, and applies no filter either: the rows are the folder.
    return { nodes: await this.withStars(this.project(files)), total: total ?? files.length };
  }

  /**
   * A folder is addressed, not looked up: the path IS the id. The listing still has to happen — it is what proves
   * the folder exists (a missing one 404s) and what fills in the item count the details panel shows.
   */
  async resolvePath(storageId: string, path: string): Promise<Node> {
    const id = joinPath(storageId, path);
    let files: WireFileNode[];
    try {
      ({ files } = await this.index(id));
    } catch (error) {
      // Only the server SAYING there is nothing here becomes `NOT_FOUND`. Everything else — a 500, a proxy, a
      // dropped connection — is a failure to ask, and the page has to say that instead of telling the person
      // their folder has been deleted.
      if (error instanceof HttpError && error.status === 404) throw new Error(NOT_FOUND);
      // A 403 is not a 404: the folder is there and this account may not read it. Telling somebody their folder
      // "may have been renamed, moved or deleted" for a permission refusal sends them looking for a file that
      // never went anywhere.
      if (error instanceof HttpError && error.status === 403) throw new Error(FORBIDDEN);
      throw error;
    }
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

  /**
   * The whole tree, breadth-first — but a LEVEL per round trip rather than a folder per round trip.
   *
   * The walk itself is unavoidable: filex answers "what is inside this folder" and nothing wider. What was
   * avoidable is doing it one folder at a time, awaited in sequence, which on a real drive is hundreds of
   * round trips in a row. A level's folders are independent, so they are asked for together and the cost
   * becomes the tree's DEPTH.
   *
   * The destination picker no longer calls this — it expands a level at a time (`listSubfolders`) and searches
   * the rest (`searchFolders`). What is left is the settings modal's folder select, which really does want them all.
   */
  async listFolders(storageId: string): Promise<Node[]> {
    const root = joinPath(storageId, '');
    const out: Node[] = [this.folderStub(root)];
    let level = [root];
    while (level.length) {
      const next: string[] = [];
      for (const nodes of await Promise.all(level.map((id) => this.listSubfolders(id)))) {
        for (const node of nodes) {
          out.push(node);
          next.push(node.id);
        }
      }
      level = next;
    }
    return out;
  }

  async listSubfolders(folderId: string): Promise<Node[]> {
    const { folders } = await request<{ folders: WireFileNode[] }>(MANAGER, { query: { q: 'subfolders', path: folderId } });
    return this.project(folders);
  }

  /**
   * `dirs_only`, so the index answers with folders and the picker does not have to sieve files out of a page it
   * asked for. No `storage_id`: the app addresses drives by name and has none to send, so the server answers for
   * every drive the caller can see and the one asked for is kept here — exact, because the sieve is over the whole
   * answer rather than over a window of it.
   */
  async searchFolders(storageId: string, text: string): Promise<Node[]> {
    const { results } = await request<{ results: WireNode[] }>('/api/files/search', {
      method: 'POST',
      body: { query: text, limit: SEARCH_LIMIT, dirs_only: true },
    });
    const out: Node[] = [];
    for (const row of results) {
      if (row.storage !== storageId) continue;
      const node = this.owned(fromModelNode(row, row.storage), row.owner_id !== undefined);
      this.remember(node.id, row.id);
      out.push(node);
    }
    return out;
  }

  // ── listings beside the tree ────────────────────────────────────────────────

  async listRecent(filter?: ListingFilter): Promise<Node[]> {
    const { nodes } = await request<{ nodes: WireNode[] }>(`${MANAGER}/recent`, {
      query: { limit: RECENT_LIMIT, ...listingFacets(filter) },
    });
    // The endpoint answers newest-opened first and now dates each row with `opened_at`, which `fromModelNode` reads
    // into `openedAt` — the field the page sorts and makes its day groups from.
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
   * The facets travel with the request, like every other listing's: the endpoint builds the whole set before paging
   * it, so its maximum page is the filtered set up to that many shared items rather than the matches among the
   * first hundred.
   */
  async listShared(filter?: ListingFilter): Promise<Node[]> {
    const { files } = await request<{ files: WireFileNode[] }>(`${MANAGER}/shared-with-me`, {
      query: { limit: SHARED_LIMIT, ...listingFacets(filter) },
    });
    // A row's address is its identity, which is how the grant's own fields find their node again after projection.
    const grants = new Map(files.map((row) => [row.path, row] as const));
    return this.project(files).map((n) => ({ ...n, shared: true, ...granter(grants.get(n.id)) }));
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
    await request(MANAGER, { method: 'POST', query: { q: 'newfolder' }, body: { path: parentId, name } }).catch(asDuplicateName);
    return this.getNode(childPath(parentId, name));
  }

  async createFile(parentId: string, name: string): Promise<Node> {
    await request(MANAGER, { method: 'POST', query: { q: 'newfile' }, body: { path: parentId, name } }).catch(asDuplicateName);
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
      body: { path: parentId, name: file.name, size: blob.size, mime: blob.type || undefined, chunk_size: CHUNK_BYTES, if_exists: options?.ifExists },
      signal: options?.signal,
    }).catch((error: unknown) => asUploadConflict(error, 'begin', null));
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
    } catch (error) {
      // Gone, expired, or never ours — the server saying so is the only thing that means "nothing to resume".
      // Anything else (offline, a proxy, a 500) is not an answer about the session: reading it as one wiped every
      // resumable record on an offline start, while the staged bytes and their quota reservation were still there.
      if (error instanceof HttpError && (error.status === 404 || error.status === 410)) return null;
      throw error;
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
    const wire = await request<WireUploadStatus>(`${UPLOAD}/${id}`);
    return this.pump(id, parentId, file, blob, wire.offset ?? 0, wire.chunk_size ?? wire.chunkSize ?? CHUNK_BYTES, options);
  }

  async abortUpload(id: string): Promise<void> {
    await request(`${UPLOAD}/${id}`, { method: 'DELETE' });
  }

  async commitUpload(sessionId: string, parentId: string, name: string, options?: UploadOptions): Promise<Node> {
    // No body at all when nothing is asked: the server's default is `replace`, and a body it was not written for
    // is not something an older server has to read.
    const commit = await request<WireUploadCommit>(`${UPLOAD}/${sessionId}/commit`, {
      method: 'POST',
      body: options?.ifExists ? { if_exists: options.ifExists } : undefined,
      signal: options?.signal,
    }).catch((error: unknown) => asUploadConflict(error, 'commit', sessionId));
    await this.awaitOpId(commit.op_id ?? commit.opId, options?.signal);
    this.forgetStorages();
    return this.getNode(childPath(parentId, name));
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
    return this.commitUpload(id, parentId, file.name, options);
  }

  async rename(id: string, name: string): Promise<Node> {
    const parent = parentPath(id);
    if (!parent) throw new Error('a storage root cannot be renamed');
    await request(MANAGER, { method: 'POST', query: { q: 'rename' }, body: { path: parent, item: id, name } }).catch(asDuplicateName);
    this.forget(id);
    return this.getNode(childPath(parent, name));
  }

  /**
   * filex's delete IS the move to trash: the bytes are renamed into `.filex-trash/` and the row keeps its id, which
   * is what makes Restore possible. The queued worker performs the identical soft delete as the synchronous handler
   * — the same `trash.Put`, the same retag — so nothing about what lands in the trash changes with the route here.
   */
  async moveToTrash(ids: string[], signal?: AbortSignal): Promise<void> {
    if (!ids.length) return;
    await this.submitOp('delete', { source: ids }, signal);
    for (const id of ids) {
      const numeric = this.ids.get(id);
      if (numeric !== undefined) this.trashed.set(id, numeric);
      this.forget(id);
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
      await write(`${MANAGER}/restore`, { method: 'POST', body: { node_id: numeric } });
      this.trashed.delete(id);
      this.ids.set(id, numeric);
    }
  }

  /** One entry at a time; purging a deleted FOLDER takes everything that went into the trash inside it. */
  async deleteForever(ids: string[]): Promise<void> {
    for (const id of ids) {
      await write(`${MANAGER}/trash/${this.trashedNodeId(id)}`, { method: 'DELETE' });
      this.trashed.delete(id);
      this.ids.delete(id);
    }
    this.forgetStorages();
  }

  /**
   * The server purges a bounded number of entries per request and says whether more is left, so no single call has
   * to hold open for a trash of any size. Loop while it is still making progress: `more` on its own would spin
   * against entries this caller can see and may not purge, which the server skips rather than failing over.
   */
  async emptyTrash(): Promise<void> {
    for (let round = 0; round < EMPTY_TRASH_ROUNDS; round++) {
      const answer = await write<WireTrashEmpty>(`${MANAGER}/trash/empty`, { method: 'POST' });
      if (!answer.more || !answer.purged) break;
    }
    this.trashed.clear();
    this.forgetStorages();
  }

  async setStarred(ids: string[], starred: boolean): Promise<void> {
    for (const id of ids) {
      await write(`${MANAGER}/star`, { method: 'POST', body: { node_id: this.nodeId(id), starred } });
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

  /** The drive's whole vocabulary, which is what makes the tag chip editable rather than only removable. */
  async listAllTags(): Promise<string[]> {
    const { tags } = await request<{ tags: string[] | null }>(`${MANAGER}/tags/all`);
    return tags ?? [];
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await write(`${MANAGER}/tags`, { method: 'POST', body: { node_id: this.nodeId(id), tags } });
  }

  async move(ids: string[], targetFolderId: string, signal?: AbortSignal): Promise<void> {
    if (!ids.length) return;
    await this.submitOp('move', { source: ids, target: targetFolderId }, signal);
    // Every moved node now answers to a different address, so the numbers remembered against the old ones are stale.
    for (const id of ids) this.forget(id);
  }

  /**
   * filex names the copy itself (`<base>-copy<ext>` when the name is taken), so nothing is returned: the caller
   * re-reads the folder and sees what landed.
   */
  async copy(ids: string[], targetFolderId: string, signal?: AbortSignal): Promise<void> {
    if (!ids.length) return;
    await this.submitOp('copy', { source: ids, target: targetFolderId }, signal);
  }

  /** Queues one job on `POST /api/files/{verb}` and waits for it. The submit's own 4xx is still a 4xx. */
  private async submitOp(verb: 'copy' | 'move' | 'delete', body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const { op } = await write<{ op: WireOp }>(`/api/files/${verb}`, { method: 'POST', body });
    // Whatever the job does to the tree, it can also change what a drive holds.
    this.forgetStorages();
    await this.awaitOp(op, signal);
  }

  /**
   * Polls one queued op to its end. A failed job throws so the store's error path owns it, as a 4xx would; a job
   * still running when the wait runs out raises OPERATION_PENDING, which says something different — nothing went
   * wrong, the answer is simply not in yet, and the caller must neither claim success nor offer to undo half a move.
   */
  private async awaitOp(op: WireOp, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + POLL_GIVE_UP_MS;
    let current = op;
    /** The last poll that did not arrive, cleared by the next one that does; see the catch below. */
    let unanswered: unknown = null;
    for (let wait = POLL_STEP_MS; current.status === 'pending' || current.status === 'running'; wait = Math.min(wait * 2, POLL_MAX_MS)) {
      // Nobody is waiting any more — the page was left, the upload was cancelled. The worker is restart-safe and
      // carries on either way, so this is the same answer as running out of time, not a cancelled operation.
      if (signal?.aborted) throw new Error(OPERATION_PENDING);
      // Out of time: still running is OPERATION_PENDING, but a wait that ended with nobody answering is the
      // transport failure, which is a different thing to put in front of a person.
      if (Date.now() > deadline) throw unanswered ?? new Error(OPERATION_PENDING);
      await new Promise((resolve) => setTimeout(resolve, wait));
      // Asked again on the far side of the wait, which is where a caller usually leaves: no request is spent then.
      if (signal?.aborted) throw new Error(OPERATION_PENDING);
      try {
        current = await request<WireOp>(`${OPS}/${op.id}`, { signal });
        unanswered = null;
      } catch (error) {
        // A poll that did not arrive says nothing about the JOB: it is a row on the server, and asking again costs
        // nothing. Reading one dropped connection as a failed move is what had people repeat a move that had in
        // fact succeeded, and end up with it done twice — so only the server's own verdict below fails an operation.
        unanswered = error;
      }
    }
    if (current.status !== 'ok') throw new Error(current.error || `${current.kind} ${current.status}`);
  }

  /** The same wait, for a verb that answers with an op id instead of the op: the first poll fetches the row. */
  private async awaitOpId(id: number | undefined, signal?: AbortSignal): Promise<void> {
    if (id === undefined) return;
    await this.awaitOp({ id, kind: 'upload-commit', status: 'pending' }, signal);
  }

  async createShareLink(id: string): Promise<string> {
    const { url } = await write<{ url: string }>('/api/files/share', { method: 'POST', body: { path: id } });
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
    for (const share of await this.shares(id)) await write(`/api/files/share/${share.uuid}`, { method: 'DELETE' });
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
      // A group row carries no user fields at all; the two id spaces are separate, so the group's is prefixed.
      const group = grant.principal === 'group';
      const id = group ? `g:${grant.group_id}` : String(grant.user_id);
      if (seen.has(id)) continue;
      seen.add(id);
      this.grants.set(`${nodeId}|${id}`, { id: grant.id, principal: group ? 'group' : 'user' });
      const name = group ? (grant.group_name?.trim() || id) : (grant.user_display_name?.trim() || grant.user_email || id);
      people.push({
        id,
        name,
        initial: initialOf(name),
        role: LEVELS[grant.level] ?? 'viewer',
        principal: group ? 'group' : 'user',
        ...(group ? { memberCount: grant.member_count ?? 0 } : {}),
      });
    }
    return { people, canManage: can_manage ?? false };
  }

  /**
   * An address — the only handle the person granting access has — or a group id. filex resolves or creates the
   * account behind an address; an address with no account and no way to make one gets a PUBLIC LINK instead, which
   * is a different thing entirely and says so in `mode`.
   *
   * `is_dir` is the node's own kind. It used to go out as `true` for everything, so a grant on a FILE was recorded
   * against a folder that does not exist.
   */
  async addPerson(nodeId: string, target: { email: string } | { groupId: string }, role: Person['role'], isDir: boolean): Promise<InviteOutcome> {
    const who = 'email' in target ? { email: target.email } : { group_id: Number(target.groupId) };
    const wire = await write<WireInvite>('/api/files/permissions/invite', {
      method: 'POST',
      body: { path: nodeId, level: role, is_dir: isDir, ...who },
    }).catch((error: unknown) => {
      // The only 409 this route has: the drive keeps no access rules, so there is nothing to write a grant into.
      if (error instanceof HttpError && error.status === 409) throw new Error(RBAC_DISABLED);
      throw error;
    });
    return { mode: wire.mode ?? 'granted', ...(wire.url ? { url: wire.url } : {}) };
  }

  async searchGroups(text: string): Promise<GroupOption[]> {
    const { groups } = await request<{ groups: WireGroup[] | null }>('/api/files/permissions/groups', {
      query: { q: text, limit: GROUP_PICKER_LIMIT },
    });
    return (groups ?? []).map((g) => ({ id: String(g.id), name: g.name, memberCount: g.member_count ?? 0 }));
  }

  async setPersonRole(nodeId: string, personId: string, role: Person['role']): Promise<void> {
    const grant = this.grant(nodeId, personId);
    await write(`/api/files/permissions/${grant.id}`, { method: 'PATCH', query: this.principalQuery(grant), body: { level: role } });
  }

  async removePerson(nodeId: string, personId: string): Promise<void> {
    const grant = this.grant(nodeId, personId);
    await write(`/api/files/permissions/${grant.id}`, { method: 'DELETE', query: this.principalQuery(grant) });
  }

  /** Absent means the user grant, which is what every older client sent and what the server still defaults to. */
  private principalQuery(grant: { principal: 'user' | 'group' }): { principal?: string } {
    return grant.principal === 'group' ? { principal: 'group' } : {};
  }

  private grant(nodeId: string, personId: string): { id: number; principal: 'user' | 'group' } {
    const grant = this.grants.get(`${nodeId}|${personId}`);
    if (grant === undefined) throw new Error(`no grant known for ${personId} on ${nodeId}`);
    return grant;
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
    //
    // No row is marked as the live contents, because none of them is: filex snapshots a file's bytes BEFORE it
    // overwrites them, so the newest row here is what the file was before its last save. Calling it "current"
    // labelled the previous contents as the present ones and withheld Restore from the one revision somebody
    // rolling back actually wants.
    return rows.map((v) => ({
      id: String(v.id),
      at: v.created_at,
      size: v.size,
      ...(v.created_by === undefined ? {} : { authorId: String(v.created_by), authorName: v.author_name }),
    }));
  }

  /**
   * `snapshot_current`: the live bytes are snapshotted before the older ones overwrite them, so a rollback is
   * itself undoable. It is why the list grows by a row on every restore, and why no row on it is the live file.
   */
  async restoreVersion(nodeId: string, versionId: string): Promise<void> {
    await write('/api/files/versions/restore', {
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
    options.set(me.id, { id: me.id, name: me.name, initial: me.initial, role: 'owner', principal: 'user' });
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
    // The form's four scopes, in the server's spelling. "All" is the server's default and travels as no scope at
    // all; the other three each name a set of fields, and `tags` used to travel as nothing — so choosing Tags
    // searched names, paths AND contents, which is exactly what All does.
    const scope = SEARCH_SCOPES_WIRE[query.scope];
    // "Whole phrase" is sent the way every search box in the world spells it: the text in quotes. The server reads a
    // fully quoted query as a phrase INSIDE files; filename matching drops the quotes and stays subsequence-based,
    // because `invoice 2026` has to keep finding `invoice_2026.pdf`. The tag terms stay outside the quotes.
    const phrase = query.wholePhrase ? quoted(query.text) : query.text;
    const exclude = searchExclusions(query);
    const terms = [phrase, ...query.tags.map((t) => `tag:${t}`), ...exclude.terms].filter(Boolean);
    const text = terms.join(' ').trim();
    const confine = searchConfine(query);
    // The drive picker, as the one thing the search endpoint takes to narrow by drive: a row id. Looked up from
    // the cached drive list, so a name the caller cannot see — or a server too old to send ids — resolves to
    // nothing and the search stays unscoped rather than silently answering about the wrong drive.
    const drive = query.drive ? (await this.listStorages()).find((s) => s.id === query.drive) : undefined;
    // The Path box and the current-folder scope naming two folders neither of which holds the other. Nothing can
    // satisfy both, and that is the answer — no request is worth making for it.
    if (!confine) return { hits: [], total: 0, capped: false };
    // POST rather than the GET form: the facets are a list and four numbers, and the body is where filex's search
    // has always taken them. No storage_id — the app addresses drives by name and has no numeric one to send, so
    // the server asks every drive the caller could see and lets its own RBAC pass decide what comes back. Which is
    // also why a Path box naming a drive is sieved here: it is the one part of the confinement the request cannot
    // carry.
    const { results, capped } = await request<{ results: (WireNode & { snippet?: string })[]; capped?: boolean }>('/api/files/search', {
      method: 'POST',
      body: {
        query: text,
        limit: SEARCH_LIMIT,
        ...(drive?.serverId ? { storage_id: drive.serverId } : {}),
        ...(scope ? { scope } : {}),
        // "Search in → Shared files" is a facet, not a scope: it says WHICH files may answer. Its meaning is the
        // one the `shared` badge carries in every listing — a file this account published a link to that still
        // opens — and NOT "shared with me", which is a different listing with a page of its own.
        ...(query.searchIn === 'shared' ? { shared_only: true } : {}),
        ...searchFacets(query, confine),
      },
    });
    const hits: SearchHit[] = [];
    for (const row of results) {
      if (!row.storage) continue;
      if (confine.drive && row.storage !== confine.drive) continue;
      // Belt to the request's braces, and the whole answer on a server that does not know `storage_id` yet.
      if (query.drive && row.storage !== query.drive) continue;
      // "Skip this" naming a whole drive. The query language has no word for a drive — a node's path starts below
      // one — so it is sieved here, the mirror of the confinement above.
      if (exclude.skipDrive && !exclude.terms.length && row.storage === exclude.skipDrive) continue;
      const node = this.owned(fromModelNode(row, row.storage), row.owner_id !== undefined);
      this.remember(node.id, row.id);
      const parent = parentPath(node.id);
      hits.push({
        node,
        storageId: row.storage,
        folderPath: parent ? splitPath(parent).rel : '',
        // `«»` are the server's match markers, not text: unsplit, the snippet printed them literally.
        ...(row.snippet ? { snippet: fromSnippet(row.snippet) } : {}),
      });
    }
    // `capped` says the server stopped at the limit with more still matching, so the count is a floor, not a total.
    return { hits, total: hits.length, capped: capped ?? false };
  }



  /**
   * One turn, streamed. The scope chip goes with the question: the server turns it into one sentence of guidance for
   * that turn only — it is not stored with the question and not replayed, the same way the chip is not sticky on
   * screen.
   *
   * `hits` arrives whenever the assistant ran a search: the same rows the model reads as JSON, for the panel to draw
   * as cards. They are stored with the answer, so reopening the conversation redraws them.
   */
  async *assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal, context?: AssistantContext): AsyncIterable<AssistantEvent> {
    if (!conversationId) throw new Error('assistant: a conversation has to exist before a turn can be stored in it');
    yield* this.assistantTurn(conversationId, { prompt, mode, context }, signal);
  }

  /**
   * The turn nobody typed: the executor has just written what a plan did, and the assistant is let back in to deal
   * with what it left undone. The server refuses this unless that note really is the last thing said, so it cannot
   * be used to make the assistant answer itself.
   */
  async *assistantResume(conversationId: string, signal: AbortSignal): AsyncIterable<AssistantEvent> {
    yield* this.assistantTurn(conversationId, { resume: true }, signal);
  }

  private async *assistantTurn(conversationId: string, body: object, signal: AbortSignal): AsyncIterable<AssistantEvent> {
    const stream = streamJSON<WireAssistantEvent>(`${ASSISTANT_SESSIONS}/${conversationId}/turn`, body, signal);
    for await (const event of stream) {
      if (event.type === 'meta') yield { type: 'meta', conversationId: event.conversation_id ?? conversationId };
      else if (event.type === 'text') yield { type: 'text', delta: event.delta ?? '' };
      else if (event.type === 'tool') yield { type: 'tool', tool: event.tool ?? '', target: event.target };
      else if (event.type === 'card') {
        const card = fromCard(event as WireCard);
        if (card) yield { type: 'card', card };
      }
      else if (event.type === 'hits' && event.hits?.length) yield { type: 'hits', hits: event.hits.map(fromAssistantHit) };
      else if (event.type === 'report' && event.report) yield { type: 'report', report: fromReport(event.report) };
      else if (event.type === 'title' && event.title) yield { type: 'title', title: event.title };
      else if (event.type === 'error') {
        // Only the two codes the panel has words for; anything newer reads as the ordinary failure.
        const code = event.code === 'quota' || event.code === 'unavailable' ? event.code : undefined;
        yield { type: 'error', message: event.message ?? '', ...(code ? { code } : {}) };
      }
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
    const { sessions, max } = await request<{ sessions: WireChatSession[]; max?: number }>(ASSISTANT_SESSIONS);
    // The limit rides along with the list it applies to, so the client never has to hold a second copy of it.
    if (max !== undefined && max > 0) this.assistantMax = max;
    return (sessions ?? []).map(fromChatSession);
  }

  assistantSessionMax(): number {
    return this.assistantMax;
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
      messages: (messages ?? []).map(fromChatMessage),
      granted: granted ?? [],
    };
  }

  /** One path, one answer. The server takes no other shape of this call. */
  async decideAssistantRead(id: string, path: string, allow: boolean): Promise<void> {
    await request(`${ASSISTANT_SESSIONS}/${id}/approvals`, { method: 'POST', body: { path, decision: allow ? 'allow' : 'deny' } });
  }

  /** The body is empty on purpose: the work is the plan the server already stored, not anything sent from here. */
  async decideAssistantPlan(id: string, planId: string, approve: boolean): Promise<PlanOutcome> {
    const verb = approve ? 'approve' : 'cancel';
    const wire = await request<{
      status: string;
      items?: WirePlanResult[];
      done?: number;
      skipped?: number;
      failed?: number;
      message?: WireChatMessage;
    }>(`${ASSISTANT_SESSIONS}/${id}/plans/${planId}/${verb}`, { method: 'POST', body: {} });
    return {
      status: wire.status === 'cancelled' ? 'cancelled' : 'done',
      results: (wire.items ?? []).map(fromPlanResult),
      done: wire.done ?? 0,
      skipped: wire.skipped ?? 0,
      failed: wire.failed ?? 0,
      // The executor's line about this decision, written by the server and returned here so the log can show it
      // without reading the whole conversation back.
      ...(wire.message ? { note: fromChatMessage(wire.message) } : {}),
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
