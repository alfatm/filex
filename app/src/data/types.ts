export type NodeKind = 'folder' | 'file';

export type FileType = 'md' | 'image' | 'ts' | 'pdf' | 'fig' | 'csv' | 'mp4' | 'other';

/** Which placeholder thumbnail the grid card paints. */
export type ThumbnailKind = 'mountain' | 'beach' | 'code' | 'document' | 'pdf' | 'figma' | 'spreadsheet' | 'video';

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
  /** URL of the real file (served from demo-assets/): thumbnails, the preview modal and downloads read it. */
  assetUrl?: string;
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
  /** Shared-with-me nodes: who shared them and when. */
  sharedBy?: string;
  sharedAt?: string;
}

/**
 * What the server lets this user do. The first block mirrors `/api/capabilities` field for field (the backend's
 * `model.Capabilities`); the second names features filex does not report yet, so the UI can hide them the day the
 * endpoint grows them instead of hard-coding "coming soon" — see docs/BACKEND-GAP.md.
 */
export interface Capabilities {
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

/** Everything off: what an unreachable or older server is assumed to offer until it answers. */
export function noCapabilities(): Capabilities {
  return {
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

/** One stored revision of a file. The newest is `current`; restoring an older one adds a new current revision. */
export interface Version {
  id: string;
  /** When this revision became the file's content. */
  at: string;
  size: number;
  /** Who wrote the revision. Absent for anything filex snapshotted before it recorded an author. */
  authorId?: string;
  authorName?: string;
  current: boolean;
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
}

/** A staged upload the server is still holding, and how far into it that server got. */
export interface UploadSession {
  id: string;
  /** Bytes the server has accepted. */
  offset: number;
  size: number;
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
  totalBytes: number;
}

export interface Storage {
  id: string;
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
}

export interface Person {
  id: string;
  name: string;
  initial: string;
  role: 'owner' | 'editor' | 'viewer';
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
}

export type SizeUnit = (typeof SIZE_UNITS)[number];

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
  /** Folder the `current` scope is restricted to: slash-separated path from the storage root, "" for the root. */
  folderPath: string;
  modified: ModifiedPreset;
  fileType: FileTypeGroup;
  tags: string[];
  /** null = any owner. */
  ownerId: string | null;
  size: SizeRange;
  /** Path prefix filter as typed, e.g. "/demo/design/". */
  path: string;
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

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp. */
  at: string;
  hits?: SearchHit[];
  /** Questions this turn raised for the person: permission to open a file, or a plan to approve. They survive a
   * reload, because the question is still waiting. */
  cards?: AssistantCard[];
  /** The stream failed while this message was open; the text so far stays. */
  error?: boolean;
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
  /** A tool is running: what it is doing, so twenty seconds of looking around does not read as a stall. */
  | { type: 'tool'; tool: string; target?: string }
  /** Something for the person to decide: permission to open one file, or a plan of work. */
  | { type: 'card'; card: AssistantCard }
  /** The server named this conversation, so the chat list can say so without refetching it. */
  | { type: 'title'; title: string }
  /** The model call failed part-way. Whatever was streamed before it stays on screen and in the log. */
  | { type: 'error'; message: string }
  | { type: 'done' };
