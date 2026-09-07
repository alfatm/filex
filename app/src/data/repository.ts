import type {
  AssistantEvent,
  AssistantMode,
  ListingFilter,
  Node,
  Person,
  SearchQuery,
  SearchResult,
  Storage,
  UploadInput,
  User,
} from './types';

/** `createFolder` / `rename` reject with an Error carrying this message when a live sibling has the same name. */
export const DUPLICATE_NAME = 'duplicateName';

export interface Repository {
  listStorages(): Promise<Storage[]>;
  getStorage(id: string): Promise<Storage>;
  /** `filter` is applied by the repository, not by the caller: the HTTP one sends it as query params. */
  listFolder(folderId: string, filter?: ListingFilter): Promise<Node[]>;
  /** Folder at a slash-separated path relative to the storage root; "" resolves to the root. */
  resolvePath(storageId: string, path: string): Promise<Node>;
  getNode(id: string): Promise<Node>;
  /** Root-to-node chain, root first, excluding the node itself. */
  getPath(id: string): Promise<Node[]>;
  listPeople(nodeId: string): Promise<Person[]>;
  /** Options of the People chip: everyone who can own a row in the user's listings. */
  listFilterPeople(): Promise<Person[]>;
  currentUser(): Promise<User>;
  search(query: SearchQuery): Promise<SearchResult>;
  /**
   * Streams the assistant's answer to `prompt`; aborting `signal` ends the stream early. `conversationId` is the id
   * from the previous turn's `meta` event (null for the first turn) so the server keeps the context.
   */
  assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal): AsyncIterable<AssistantEvent>;

  // Listings beyond the folder tree. Trashed nodes never appear in `listFolder`, `listRecent`, `listStarred`, `listShared`.
  /** Files only, newest `openedAt` (falling back to `modifiedAt`) first. */
  listRecent(filter?: ListingFilter): Promise<Node[]>;
  listStarred(filter?: ListingFilter): Promise<Node[]>;
  /** Nodes other people shared with the current user (`sharedBy` / `sharedAt` set). */
  listShared(filter?: ListingFilter): Promise<Node[]>;
  /** Trashed nodes with `deletedAt` / `originalPath` set. */
  listTrash(filter?: ListingFilter): Promise<Node[]>;
  /** Every live folder of the storage, root included; the Move-to picker builds its tree from `parentId`. */
  listFolders(storageId: string): Promise<Node[]>;

  // Mutations. Ids are validated; unknown ids throw. Name collisions reject with `DUPLICATE_NAME`.
  createFolder(parentId: string, name: string): Promise<Node>;
  uploadFile(parentId: string, file: UploadInput): Promise<Node>;
  rename(id: string, name: string): Promise<Node>;
  moveToTrash(ids: string[]): Promise<void>;
  restore(ids: string[]): Promise<void>;
  deleteForever(ids: string[]): Promise<void>;
  emptyTrash(): Promise<void>;
  setStarred(ids: string[], starred: boolean): Promise<void>;
  move(ids: string[], targetFolderId: string): Promise<void>;
  createShareLink(id: string): Promise<string>;
  removeShareLink(id: string): Promise<void>;
  /** Marks the file as opened now (`openedAt`), which moves it to the top of Recent. */
  recordOpen(id: string): Promise<void>;
}
