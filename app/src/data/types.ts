export type NodeKind = 'folder' | 'file';

export type FileType = 'md' | 'image' | 'ts' | 'pdf' | 'fig' | 'csv' | 'mp4' | 'other';

/** Which placeholder thumbnail the grid card paints; `generic` is the fallback for a type with no art of its own. */
export type ThumbnailKind = 'mountain' | 'code' | 'document' | 'pdf' | 'figma' | 'spreadsheet' | 'video' | 'generic';

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  parentId: string | null;
  /** Bytes; 0 for folders. */
  size: number;
  /** Absent where the source records none — a storage root is not a file anything wrote. */
  modifiedAt?: string;
  /** Absent when the listing that produced the node does not carry one; the details panel then omits the row. */
  createdAt?: string;
  /** Id of the owning user; `ownerName` carries the display name when it is not the current user (shared drives). */
  ownerId: string;
  ownerName?: string;
  itemCount?: number;
  fileType?: FileType;
  thumbnail?: ThumbnailKind;
  /** URL the server serves the file's own bytes from: the preview modal and downloads read it. */
  assetUrl?: string;
  /** The server's cached 320px preview of the file; the grid and list tiles paint it, never the original. */
  thumbUrl?: string;
  /** Last time the user opened (previewed) the file; Recent orders by it ahead of `modifiedAt`. */
  openedAt?: string;
  /** Video duration label, e.g. "02:14". */
  duration?: string;
  shared: boolean;
  shareUrl?: string;
  starred: boolean;
  tags?: string[];
  /** Set while the node sits in the trash; `originalPath` is the folder it came from ("/demo/Design"). */
  deletedAt?: string;
  originalPath?: string;
  /** Trash rows: days left before the automatic purge, as the server counts them down. */
  ttlDays?: number;
  /** Shared-with-me nodes: who shared them and when. */
  sharedBy?: string;
  sharedAt?: string;
}

/**
 * What the server lets this user do. The first block mirrors `/api/capabilities` field for field (the backend's
 * `model.Capabilities`); the second names features filex does not report yet, so the UI can hide them the day the
 * endpoint grows them instead of hard-coding "coming soon" — see docs/BACKEND-GAP.md.
 */
/**
 * What a ROLE may do, as filex's RBAC names the operations (`permissions` on `GET /api/files/capabilities`).
 *
 * Distinct from the rest of `Capabilities`, which answers for the INSTALLATION: a server that can move files still
 * refuses the move when the caller's role has no `files.move`. Both have to say yes before an action is offered,
 * and only this one produces "Your role may not do this" rather than "Not available on this server".
 */
export const ROLE_PERMISSIONS = [
  'files.upload',
  'files.mkdir',
  'files.rename',
  'files.move',
  'files.copy',
  'files.delete',
  'files.purge',
  'files.restore',
  'files.download',
  'files.share',
  'files.grant',
  'files.tags',
  'files.star',
] as const;

export type RolePermission = (typeof ROLE_PERMISSIONS)[number];

export interface Capabilities {
  /**
   * The caller's role permissions. Named `allowed` and not `permissions` because that field is already taken here
   * by "this installation has an access-control surface at all", which is a different question.
   */
  allowed: Set<RolePermission>;
  upload: boolean;
  move: boolean;
  copy: boolean;
  /** Move to trash. */
  delete: boolean;
  mkdir: boolean;
  search: boolean;
  versions: boolean;

  assistant: boolean;
  tags: boolean;
  activity: boolean;
  /** Reading and changing who has access to a node. */
  permissions: boolean;
  /** Emptying the trash and deleting a node for good; admin-only in filex today. */
  deleteForever: boolean;
  /** Downloading a folder or a mixed selection as one archive. */
  folderDownload: boolean;
  /** "How to connect" and "API keys": the shared panels, which need a real server to answer for. */
  connections: boolean;
}

/**
 * What the operator has branded this installation with (`GET /api/branding`, public).
 *
 * Every field is optional in the sense that an unbranded install answers with empty strings; the app then keeps
 * its own name, mark and accent. `footerText` and `hidePoweredBy` are not carried: they exist for the public
 * share and drop pages, and this app has no footer to put them in.
 */
export interface Branding {
  /** Shown beside the mark, in the browser tab, and in place of "filex". */
  name: string;
  /** http(s), site-relative, or a `data:image/…` URI. */
  logoUrl: string;
  /** `#rgb` or `#rrggbb`; anything else is dropped by the server before it reaches here. */
  accent: string;
}

/** An unbranded install: the app's own name, mark and accent stand. */
export function noBranding(): Branding {
  return { name: '', logoUrl: '', accent: '' };
}

/**
 * Every INSTALLATION feature off: what an unreachable or older server is assumed to offer until it answers.
 *
 * ⚠ `allowed` is the exception, and deliberately holds the lot. A role permission is a rule saying what a role may
 * NOT do, so "we do not know" has to read as "nothing is withheld" — the same reading `HttpRepository.capabilities`
 * already gives a server that sends no `permissions` field at all, and the two have to agree. Read as "none", a
 * single failed snapshot at start-up (a proxy 502) would disable restore, share, rename, starring and download —
 * actions with no installation-side gate behind them — and tell the person to ask an administrator about a
 * transient failure. Nothing dangerous opens: every capability the server answers for stays false below.
 */
export function noCapabilities(): Capabilities {
  return {
    allowed: new Set(ROLE_PERMISSIONS),
    upload: false,
    move: false,
    copy: false,
    delete: false,
    mkdir: false,
    search: false,
    versions: false,
    assistant: false,
    tags: false,
    activity: false,
    permissions: false,
    deleteForever: false,
    folderDownload: false,
    connections: false,
  };
}

/**
 * One stored revision of a file.
 *
 * There is no row for the LIVE contents: filex snapshots a file's bytes before it overwrites them, so every row is
 * something the file used to be. Restoring one snapshots the live bytes first, which is why the list grows by one
 * row rather than losing what was there.
 */
export interface Version {
  id: string;
  /** When this revision became the file's content. */
  at: string;
  size: number;
  /** Who wrote the revision. Absent for anything filex snapshotted before it recorded an author. */
  authorId?: string;
  authorName?: string;
}

/** What happened to a node, newest first. `detail` carries the one variable part of the sentence (a name, a folder). */
export interface ActivityEvent {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  kind: 'created' | 'modified' | 'renamed' | 'moved' | 'linkShared' | 'linkRemoved' | 'invited' | 'revoked' | 'trashed' | 'restored' | 'starred' | 'unstarred' | 'tagged';
  detail?: string;
}

/** What the upload flow hands to the repository once a file has "arrived". */
export interface UploadInput {
  name: string;
  size: number;
  /** The bytes. The mock never reads them; the HTTP repository has nothing to send without them. */
  blob?: Blob;
}

/**
 * How a transfer reports itself while it runs: `sent` is the byte count the SERVER has accepted, out of `total`.
 * The staged upload path knows that number after every chunk; the mock plays the same steps so the tray has
 * something to draw without a network.
 */
export interface UploadOptions {
  onProgress?: (sent: number, total: number) => void;
  /** Stops the transfer where it stands. What is already staged stays staged — dropping it is `abortUpload`. */
  signal?: AbortSignal;
  /**
   * The server's id for this transfer, as soon as there is one.
   *
   * ⚠ This is the only way a transfer can be picked up again after the page reloads: `POST /upload/begin` always
   * opens a NEW session at offset 0, so an id that was not written down is a staged upload nobody can continue.
   */
  onSession?: (id: string) => void;
  /**
   * What to do about a file already at the target, decided by the SERVER at `begin` and again at `commit`.
   * `replace` (the default when omitted) overwrites it; `fail` makes the call reject with `UploadConflict` instead,
   * which is what lets the store ask the person — or pick another name — without listing the folder first.
   */
  ifExists?: 'replace' | 'fail';
}

/** A staged upload the server is still holding, and how far into it that server got. */
export interface UploadSession {
  id: string;
  /** Bytes the server has accepted. */
  offset: number;
  size: number;
}

/**
 * What the sign-in form sends.
 *
 * `identifier` and not `email`: filex's local realm resolves an e-mail address OR a username, and the field is
 * labelled for both. `totp` is only ever filled in once the server has said it wants one — a realm without a
 * second factor rejects nothing for its absence, and asking everybody up front for a code most accounts do not
 * have is how a sign-in screen teaches people to ignore it.
 */
export interface Credentials {
  identifier: string;
  password: string;
  totp?: string;
  /** Ask the server for a long-lived session rather than one that ends with the browser. */
  remember?: boolean;
}

/**
 * What the sign-in screen has to know BEFORE anyone is signed in (`GET /api/capabilities`, public).
 *
 * Separate from the `Capabilities` snapshot the shell reads: that one is asked for as a signed-in user and folds
 * in the assistant probe, which answers 401 to a visitor. This is the pre-session half — which realms may be
 * offered, whether SSO should take over on its own, and the build to print under the card.
 */
export interface AuthOptions {
  /** Realm names, as filex's `AUTH_DRIVERS` spells them: "local", "oidc", "proxyheader". Empty means local only. */
  drivers: string[];
  /** FILEX_OIDC_AUTO_REDIRECT: an SSO-first install sends a visitor to the IdP instead of showing the form. */
  oidcAutoRedirect: boolean;
  /** `<version> (<commit>, <date>)`, printed under the card; empty when the server does not say. */
  version: string;
}

/** What a server that has not answered is assumed to offer: the password form, and nothing else. */
export function noAuthOptions(): AuthOptions {
  return { drivers: [], oidcAutoRedirect: false, version: '' };
}

/**
 * How the signed-in account authenticates. filex's second factor and the password both belong to the auth
 * provider, not to this app: an OIDC realm answers `changePassword: false`, and its second step is configured
 * wherever the identity provider lives.
 */
export interface AuthMethods {
  /** The realm's auth type, which is also its driver name: "local", "oidc", "proxyheader". */
  provider: string;
  changePassword: boolean;
  /** filex's own TOTP. Only meaningful on a local realm. */
  totpEnabled: boolean;
}

/**
 * A pending second-factor enrolment, as `POST /api/auth/totp/enroll` hands it back. The recovery codes are shown
 * this once: no endpoint reads them back, and enrolling again replaces the set. (They are stored as written, the
 * way the TOTP secret beside them is — whoever can read the users table can read both.)
 */
export interface TotpEnrollment {
  /** The shared secret, base32, for typing into an authenticator that cannot scan. */
  secret: string;
  otpauthUrl: string;
  /** The QR of `otpauthUrl`, drawn by the server as an inline `<svg>`. */
  qrSvg: string;
  recoveryCodes: string[];
}

/**
 * One place this account is signed in: filex has recorded ip, user agent and expiry for every session since its
 * first migration. `current` marks the session the app itself is calling with — the one row that gets no "end
 * session" button, because ending it is signing out.
 */
export interface Session {
  id: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

/**
 * The three notification switches the settings modal owns. They are the ACCOUNT's, not this browser's:
 * filex keeps a per-user mute list, and the server reads it when it decides whether an event rings.
 */
export interface NotifyPrefs {
  shared: boolean;
  comments: boolean;
  uploads: boolean;
}

export interface Quota {
  usedBytes: number;
  /** 0 = no ceiling. */
  totalBytes: number;
  usedFiles: number;
  /** How many files the account may hold; 0 = no ceiling. */
  totalFiles: number;
  /** Bytes uploaded inside the rolling window, and what the window allows; 0 = no ceiling. */
  uploadUsedBytes: number;
  uploadTotalBytes: number;
  /** Length of that rolling window, in hours. */
  uploadWindowHours: number;
}

/** An account with no ceiling of any kind: what a server that does not meter answers, and the starting point. */
export function noQuota(): Quota {
  return { usedBytes: 0, totalBytes: 0, usedFiles: 0, totalFiles: 0, uploadUsedBytes: 0, uploadTotalBytes: 0, uploadWindowHours: 0 };
}

export interface Storage {
  id: string;
  /**
   * The drive's id on the server, for the one endpoint that takes one.
   *
   * `id` above is the NAME, and it stays the app's way of addressing a drive — every route, every node id and
   * every other request is built from it. Search is the exception: `/api/files/search` narrows to a drive by
   * `storage_id` and by nothing else, so before this the app could only ask for everything and drop the rows from
   * other drives, which makes the result count a claim about a page rather than about the drive.
   *
   * 0 from a server too old to send it — the drive picker treats that as "cannot narrow" rather than as drive 0.
   */
  serverId: number;
  name: string;
  rootId: string;
  quota: Quota;
  /**
   * A drive the person reaches through grants rather than through their own role — a team drive.
   *
   * It changes who the Owner column names. On a drive of one's own, naming a person is useful: it is either you or
   * whoever put the file there. On a shared drive it is noise — what matters is that the drive is not yours — so
   * the column names the DRIVE, the way Drive names a shared drive.
   */
  shared: boolean;
  /**
   * Names of the groups through which the caller holds grants on this drive; empty when they reach it some other
   * way. The Owner column names the FIRST of them rather than the drive: a team drive reached through "Design" is
   * more usefully labelled by the team than by the mount it happens to live on.
   */
  viaGroups: string[];
}

export interface Person {
  /** A user id, or `g:<group id>` for a group: the two id spaces are separate and the prefix keeps them apart. */
  id: string;
  name: string;
  initial: string;
  role: 'owner' | 'editor' | 'viewer';
  /** Which kind of principal holds the grant; a group row is drawn with the group icon and its member count. */
  principal: 'user' | 'group';
  /** Groups only: how many accounts are in the group. */
  memberCount?: number;
}

/** A group as the picker offers it. */
export interface GroupOption {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * What an invite did.
 *
 * `granted` — the account existed and now has the grant; `user_created` — filex made the account first; `shared` —
 * there is NO account for that address, so a public link was minted instead. The last one adds nobody to the list,
 * which is why the modal has to say so rather than silently showing an unchanged list.
 *
 * The middle one is spelled the server's way (`user_created`, not `created`): the admin explorer in
 * `packages/core` has typed it so since before this app existed, and one name for one wire value beats a tidier one.
 */
export interface InviteOutcome {
  mode: 'granted' | 'user_created' | 'shared';
  /** The public link, present only for `shared`. */
  url?: string;
}

/**
 * Who can reach a node, and whether the caller is allowed to change that. Reading the list needs only the right to
 * open the node; changing it is the owner's business, so the panel that shows both has to be told which it holds.
 */
export interface Access {
  people: Person[];
  canManage: boolean;
}

export interface User {
  id: string;
  name: string;
  initial: string;
  email: string;
  /** Shown as a badge in the settings modal; the backend's own role names map onto it. */
  role: 'owner' | 'admin' | 'member';
  /** Profile picture — a URL or a small `data:` URI. Absent means the avatar draws the initial. */
  avatarUrl?: string;
  /** Optional profile fields the account carries; empty means the person never filled them in. */
  fullName?: string;
  jobTitle?: string;
  /** Preferences the ACCOUNT carries, so they follow the person to another browser. */
  locale?: string;
  timeZone?: string;
}

/** What the settings modal may change about the account; an absent field is left alone. */
export interface ProfilePatch {
  name?: string;
  /** Optional; an empty string clears the field, which is how a job title is removed. */
  fullName?: string;
  jobTitle?: string;
  locale?: string;
  timeZone?: string;
  /** An empty string removes the picture. */
  avatarUrl?: string;
}

// The allowed-value lists double as the URL-parsing whitelists in features/search/searchStore.ts.
export const SEARCH_SCOPES = ['all', 'content', 'paths', 'tags'] as const;
export const SEARCH_INS = ['current', 'all', 'shared'] as const;
export const MODIFIED_PRESETS = ['any', 'today', 'week', 'month', 'year'] as const;
export const FILE_TYPE_GROUPS = ['any', 'documents', 'images', 'videos', 'code', 'spreadsheets', 'design'] as const;
export const SIZE_PRESETS = ['any', 'small', 'medium', 'large', 'custom'] as const;
export const SIZE_UNITS = ['KB', 'MB', 'GB'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export type SearchIn = (typeof SEARCH_INS)[number];
export type ModifiedPreset = (typeof MODIFIED_PRESETS)[number];
export type FileTypeGroup = (typeof FILE_TYPE_GROUPS)[number];
export type SizePreset = (typeof SIZE_PRESETS)[number];

/**
 * What the filter chips above a listing express: the subset of `SearchQuery` a listing can carry. The repository
 * applies it — the mock in `mock/search.ts`, the HTTP one as query params — so the store never post-filters rows
 * the server already returned, and a folder with 10k children stays one request.
 */
export interface ListingFilter {
  fileType: FileTypeGroup;
  modified: ModifiedPreset;
  size: Exclude<SizePreset, 'custom'>;
  /** Matches the owner or, on Shared with me, whoever shared the node; null means anyone. */
  personId: string | null;
  /** Case-insensitive substring of the name; "" means any name. Keeps folders, like Modified and People do. */
  name: string;
  /** Every tag listed has to be on the node (AND); empty means any. Lower-cased, as the server stores them. */
  tags: string[];
  /** "Written around the same time as that one" — see `DateWindow`; null means any date. */
  around: DateWindow | null;
}

/**
 * A window of a fixed width around one moment, which is what the details panel's date rows filter by: the files
 * WRITTEN (or catalogued) within a day either side of the one being described.
 *
 * `modified` and `created` are two different columns on the server, so which one the window tests travels with it.
 * It is separate from the Modified chip's presets — those are windows that end at now — and the two are mutually
 * exclusive: setting either clears the other, because one date column cannot answer two windows at once.
 */
export interface DateWindow {
  field: 'modified' | 'created';
  /** ISO timestamp at the centre of the window. */
  at: string;
  /** How wide the window is, either side of `at`. */
  span: AroundSpan;
}

/** The window widths the date chip offers. A day is what a property click starts with. */
export const AROUND_SPANS = ['hour', 'day', 'week'] as const;
export type AroundSpan = (typeof AROUND_SPANS)[number];

/**
 * A folder's children as the server answered them. `total` counts the LIVE children before `ListingFilter` was
 * applied — what tells the store whether the folder is small enough to hold whole and sieve in memory.
 */
export interface FolderListing {
  nodes: Node[];
  total: number;
}

export type SizeUnit = (typeof SIZE_UNITS)[number];

export const PATH_MODES = ['only', 'skip'] as const;
export type PathMode = (typeof PATH_MODES)[number];

export interface SizeRange {
  preset: SizePreset;
  /** Only used with the `custom` preset; expressed in `unit`. */
  min: number | null;
  max: number | null;
  unit: SizeUnit;
}

/** Advanced-search form state (spec §5). Mirrored into the `/search` URL query. */
export interface SearchQuery {
  text: string;
  scope: SearchScope;
  searchIn: SearchIn;
  /**
   * One drive to search, by NAME, or null for every drive the account can see.
   *
   * It is the drive's name rather than its `serverId` because this object is written into the URL and read back
   * out of it: `?drive=demo` still names the same drive after a re-import that renumbered the rows, and it is
   * legible in a shared link. The id it travels to the server as is looked up at request time.
   */
  drive: string | null;
  /** Folder the `current` scope is restricted to: slash-separated path from the storage root, "" for the root. */
  folderPath: string;
  modified: ModifiedPreset;
  /**
   * "Around this moment", the same window the listing chips carry — and the only way to ask about the CREATION
   * date, which the presets above do not reach. Mutually exclusive with `modified`: two windows over one column
   * is a question nothing can answer.
   */
  around: DateWindow | null;
  fileType: FileTypeGroup;
  tags: string[];
  /** null = any owner. */
  ownerId: string | null;
  size: SizeRange;
  /** Path filter as typed, e.g. "/demo/design/". What it MEANS is `pathMode`'s. */
  path: string;
  /**
   * Which way the Path box reads: `only` confines the search to that subtree (the prefix filter it has always
   * been), `skip` leaves it out.
   *
   * Two modes on one box rather than two boxes, because they are the same question asked in two directions and
   * nobody asks both at once about the same folder. The mode travels with the path for the same reason a
   * `DateWindow` carries its own field: a value whose meaning lives somewhere else is a value that eventually
   * gets read the wrong way.
   */
  pathMode: PathMode;
  /**
   * Folders left OUT of the answer, storage-relative ("Design/Old"), as the chips above a result list express
   * them: one per chip, added by pointing at a result that came from one.
   *
   * Separate from `path` because it is a different act. The Path box is a folder somebody TYPED, one at a time,
   * before seeing anything; these are folders somebody REJECTED, from a list in front of them, and there is no
   * reason the second one should replace the first. Both end up as `-path:` terms in the request.
   */
  excludePaths: string[];
  /** Sent as a quoted query: the words in that order, adjacent, inside the file. */
  wholePhrase: boolean;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  node: Node;
  storageId: string;
  /** Containing folder as in `SearchQuery.folderPath`: slash-separated path below the storage root, "" for the root. */
  folderPath: string;
  snippet?: { text: string; ranges: MatchRange[] };
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  /**
   * The answer stopped at the limit with more still matching, so `total` is a floor rather than a count.
   *
   * A true total is not cheaply knowable: the index over-fetches candidates and the scorer, the facets, the tenant
   * pass and RBAC each drop some, so counting them all means running the whole pipeline over the whole drive. What
   * IS knowable is whether the answer was cut off — and saying "100+" is honest where saying "100" was not.
   */
  capped: boolean;
}

export type AssistantMode = 'filename' | 'content' | 'tags';

/** The pages the assistant has words for; a question asked anywhere else travels without a context. */
export type AssistantPage = 'folder' | 'search' | 'recent' | 'starred' | 'shared' | 'trash' | 'home';

/**
 * What the person is looking at when they ask, so "these files" and "this folder" mean something to the model.
 * Sent with the turn and appended to that question only — like the mode chip, it is not stored and not replayed.
 */
export interface AssistantContext {
  page: AssistantPage;
  /** The open folder's address on the folder page. */
  folder?: string;
  /** Addresses of the selected rows, in listing order; the first `MAX_CONTEXT_SELECTED` of them. */
  selected?: string[];
  /** How many rows are selected, when more than `selected` carries. */
  selectedTotal?: number;
  /** The search page's state: the query, the non-default settings as `name: value`, the count and the first hits. */
  search?: { query: string; filters: string[]; total: number; capped: boolean; hits: string[] };
}

/**
 * One conversation with the assistant. Carries no message text: the list is drawn from these, and the messages of a
 * session are fetched only when it is opened — which is also how the server keeps them out of the operator's reach.
 */
export interface AssistantSession {
  id: string;
  title: string;
  /** True once somebody named it by hand; the title generator then leaves it alone. */
  titleManual: boolean;
  messageCount: number;
  /** Ordering key of the list AND of eviction: the least recently ACTIVE session is the one that goes. */
  lastActiveAt: string;
  createdAt: string;
}

/**
 * The assistant asking to open one file. It is shown as a card with the file and the reason, because permission is
 * given per file: approving one is not approving the next, and there is no "allow everything" anywhere in the flow.
 */
export interface ApprovalCard {
  kind: 'approval';
  /** The file, as `<drive>://<path>`. */
  path: string;
  /** Why the assistant wants it, in its own words. */
  reason?: string;
  /**
   * How it ended, once it has. The turn stands still at the card until the person answers or the server stops
   * waiting (`expired`); a card without one is still in front of the person.
   */
  decision?: 'allowed' | 'denied' | 'expired';
}

/**
 * One line of a plan: what will happen to what.
 *
 * `action` is a CODE (`tag`, `restore_version`, `revoke_share`, `purge`), not a sentence, and the size and date are
 * raw — the panel says it in the reader's language and formats them the way the rest of the app does.
 */
export interface PlanItem {
  path: string;
  action: string;
  /** Values the wording interpolates: the tags being applied, the version number, a download count. */
  args?: Record<string, string>;
  size?: number;
  /** ISO timestamp; what it means depends on the plan (when a version was taken, when a file was deleted). */
  at?: string;
}

/** What happened to one item once the plan ran. */
export interface PlanResult {
  path: string;
  state: 'done' | 'skipped' | 'failed';
  /** Why, from a closed set the interface has words for: `gone`, `changed`, `forbidden`, `missing`, `broken`. */
  code?: string;
  /** The same thing in English, shown only when the code is one this build does not know. */
  reason?: string;
  /**
   * The link a `create_share` plan minted. Stored with the answer and redrawn when the conversation is reopened,
   * because a link nobody was shown is a link nobody can use — which also means it stays in the transcript after
   * the link is revoked. What it records is what was minted, not that the link still opens.
   */
  url?: string;
}

/**
 * Work the assistant proposed and the person decides on. The model wrote this plan and then stopped being involved:
 * approving it runs what the SERVER stored, item by item, so nothing the model says afterwards can change it.
 */
export interface PlanCard {
  kind: 'plan';
  id: string;
  /** What sort of work: `tags`, `restore_version`, `revoke_share`, `empty_trash`. */
  planKind: string;
  summary: string;
  items: PlanItem[];
  status: 'pending' | 'done' | 'cancelled';
  /** Present once it ran. */
  results?: PlanResult[];
}

/** What came back from running a plan. */
export interface PlanOutcome {
  status: 'done' | 'cancelled';
  results: PlanResult[];
  done: number;
  skipped: number;
  failed: number;
}

/** A card is either a request to open one file or a plan of work. Both are answered by the person, not the model. */
export type AssistantCard = ApprovalCard | PlanCard;

/** One conversation as the server holds it: the turns, and the files this conversation may open. */
export interface AssistantConversation {
  messages: AssistantMessage[];
  granted: string[];
}

/**
 * Why a turn did not finish. `failed` is the ordinary case — try again; the others say who has to act instead:
 * `quota`, the provider account is out of credit (an administrator's); `unavailable`, the assistant was switched off
 * or its provider no longer answers for it; `timeout`, the server said nothing for a minute and the app gave up;
 * `answering`, this account's other tab is mid-answer; `rateLimited`, it has asked too often this minute. The
 * server answers 429 to both and names which in the body's `code`; `busy` is the sentence that covers both, for a
 * refusal it could not classify.
 */
export type AssistantFailure = 'failed' | 'quota' | 'unavailable' | 'timeout' | 'busy' | 'answering' | 'rateLimited';

/**
 * A document a tool wrote for the person — a list of files, a search's results, a written report — kept with the
 * answer and downloadable as text or CSV. The rows are the shape of search results, so the panel draws and opens
 * them the same way; they are the files as the server found them, not as the model remembered them.
 */
export interface AssistantReport {
  title: string;
  /** Markdown: the report itself, or a note above the list. */
  text?: string;
  rows: SearchHit[];
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp. */
  at: string;
  hits?: SearchHit[];
  /** Documents the tools wrote for the person during this turn. */
  reports?: AssistantReport[];
  /** Questions this turn raised for the person: permission to open a file, or a plan to approve. They survive a
   * reload, because the question is still waiting. */
  cards?: AssistantCard[];
  /** The stream failed while this message was open, and how; the text so far stays. */
  error?: AssistantFailure;
  /** The stream was stopped (panel closed) while this message was open. */
  aborted?: boolean;
}

/**
 * One assistant turn is a stream: `meta` (first) carries the conversation id the next turn must send back,
 * `text` appends to the open assistant message, `hits` appends result cards to it (a second `hits` event adds
 * to the cards already attached, it never replaces them), `done` closes it (a later `text` starts a new message,
 * e.g. a follow-up). The iterable ending finishes the turn.
 */
export type AssistantEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'text'; delta: string }
  | { type: 'hits'; hits: SearchHit[] }
  /** A tool wrote a document for the person; it attaches to the open message like `hits` do. */
  | { type: 'report'; report: AssistantReport }
  /** A tool is running: what it is doing, so twenty seconds of looking around does not read as a stall. */
  | { type: 'tool'; tool: string; target?: string }
  /** Something for the person to decide: permission to open one file, or a plan of work. */
  | { type: 'card'; card: AssistantCard }
  /** The server named this conversation, so the chat list can say so without refetching it. */
  | { type: 'title'; title: string }
  /** The model call failed part-way. Whatever was streamed before it stays on screen and in the log. `code` is
   * present only when the failure is one the person can act on. */
  | { type: 'error'; message: string; code?: 'quota' | 'unavailable' }
  | { type: 'done' };
