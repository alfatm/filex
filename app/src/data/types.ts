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
  ocr: boolean;

  assistant: boolean;
  tags: boolean;
  activity: boolean;
  /** Reading and changing who has access to a node. */
  permissions: boolean;
  /** Emptying the trash and deleting a node for good; admin-only in filex today. */
  deleteForever: boolean;
  /** Downloading a folder or a mixed selection as one archive. */
  folderDownload: boolean;
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
    ocr: false,
    assistant: false,
    tags: false,
    activity: false,
    permissions: false,
    deleteForever: false,
    folderDownload: false,
  };
}

/** One stored revision of a file. The newest is `current`; restoring an older one adds a new current revision. */
export interface Version {
  id: string;
  /** When this revision became the file's content. */
  at: string;
  size: number;
  authorId: string;
  authorName: string;
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

export interface Quota {
  usedBytes: number;
  totalBytes: number;
}

export interface Storage {
  id: string;
  name: string;
  rootId: string;
  quota: Quota;
}

export interface Person {
  id: string;
  name: string;
  initial: string;
  role: 'owner' | 'editor' | 'viewer';
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
  /** Preferences the ACCOUNT carries, so they follow the person to another browser. */
  locale?: string;
  timeZone?: string;
}

/** What the settings modal may change about the account; an absent field is left alone. */
export interface ProfilePatch {
  name?: string;
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
  wholePhrase: boolean;
  caseSensitive: boolean;
  ocr: boolean;
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
}

export type AssistantMode = 'filename' | 'content' | 'tags';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp. */
  at: string;
  hits?: SearchHit[];
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
  | { type: 'done' };
