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
  modifiedAt: string;
  createdAt: string;
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

/** What the upload flow hands to the repository once a file has "arrived". */
export interface UploadInput {
  name: string;
  size: number;
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
