import type {
  Access,
  ActivityEvent,
  AssistantConversation,
  PlanOutcome,
  AssistantSession,
  AssistantEvent,
  AuthMethods,
  AssistantMode,
  Capabilities,
  ListingFilter,
  Node,
  NotifyPrefs,
  Person,
  ProfilePatch,
  SearchQuery,
  SearchResult,
  Session,
  Storage,
  UploadInput,
  UploadOptions,
  UploadSession,
  User,
  Version,
} from './types';

/** `createFolder` / `rename` reject with an Error carrying this message when a live sibling has the same name. */
export const DUPLICATE_NAME = 'duplicateName';

/** `changePassword` rejects with this when the current password does not match. */
export const WRONG_PASSWORD = 'wrongPassword';

/**
 * `move` and `moveToTrash` reject with this when the server took the work but has not finished it yet: the job is
 * queued and running, so it is neither a success to report nor a failure to undo. Only the HTTP repository can
 * raise it — the mock does its work in memory and is always done.
 */
export const OPERATION_PENDING = 'operationPending';

/** filex refuses anything shorter, so the form says so before a request goes out. */
export const MIN_PASSWORD_LENGTH = 8;

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
  /** Everyone who can reach the node, plus whether this caller may change the list. */
  listPeople(nodeId: string): Promise<Access>;
  /** Adds someone by email address; the display name is derived server-side. */
  addPerson(nodeId: string, email: string, role: Person['role']): Promise<void>;
  setPersonRole(nodeId: string, personId: string, role: Person['role']): Promise<void>;
  removePerson(nodeId: string, personId: string): Promise<void>;
  /** Revisions of a file, newest first; folders have none. */
  listVersions(nodeId: string): Promise<Version[]>;
  /** Makes an older revision the current one, keeping the ones in between. */
  restoreVersion(nodeId: string, versionId: string): Promise<void>;
  /** What happened to a node, newest first. */
  listActivity(nodeId: string): Promise<ActivityEvent[]>;
  /** Options of the People chip: everyone who can own a row in the user's listings. */
  listFilterPeople(): Promise<Person[]>;
  currentUser(): Promise<User>;
  /** Saves the account fields the settings modal owns and answers with the account as it now stands. */
  updateProfile(patch: ProfilePatch): Promise<User>;
  /** Rejects with `WRONG_PASSWORD` when `currentPassword` is not the account's. */
  /**
   * Where to point the browser to get `nodes` as one archive, or null when the server cannot zip. A URL builder
   * rather than a request: the download has to be a navigation, so the browser owns the save dialog, the progress
   * and the disk write instead of the page holding the whole archive in memory.
   */
  archiveUrl(nodes: Node[]): string | null;

  /** How this account signs in, and what it may change here: the Security card asks before it offers anything. */
  authMethods(): Promise<AuthMethods>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** The three notification switches, read from the account's mute list. */
  notifyPrefs(): Promise<NotifyPrefs>;
  /** Writes them back, leaving every event the app does not own exactly as it found it. */
  saveNotifyPrefs(prefs: NotifyPrefs): Promise<void>;
  /** Where this account is signed in, newest first; the caller's own session is flagged `current`. */
  listSessions(): Promise<Session[]>;
  /** Ends one of those sessions. The server refuses the current one — signing out is a different button. */
  revokeSession(id: string): Promise<void>;
  /** Feature snapshot for this user; read once at start-up. */
  capabilities(): Promise<Capabilities>;
  search(query: SearchQuery): Promise<SearchResult>;
  /**
   * Streams the assistant's answer to `prompt`; aborting `signal` ends the stream early. `conversationId` is the
   * conversation this turn belongs to — against a live server that is the stored session, which is where the
   * question and the answer are both written, so a turn without one has nowhere to go.
   */
  assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal): AsyncIterable<AssistantEvent>;

  // The assistant's history. Private to the account: the server has no route that hands one person's conversation
  // to anybody else, an administrator included.
  /** Most recently active first — the order the list is drawn in and the order eviction reads from the far end. */
  listAssistantSessions(): Promise<AssistantSession[]>;
  /** Starts one. Reaching the per-account cap evicts the least recently active session rather than refusing. */
  createAssistantSession(title?: string): Promise<AssistantSession>;
  /** The turns of one conversation, plus the files it has been given permission to open. */
  assistantMessages(id: string): Promise<AssistantConversation>;
  /**
   * Records permission to read ONE file in this conversation. There is no form of this call that approves a folder,
   * a pattern or everything — that is the rule it exists to keep.
   */
  approveAssistantRead(id: string, path: string): Promise<void>;
  /**
   * Runs a plan the person approved, or drops it. The call carries no work: everything that will happen is already
   * in the plan the server stored, so there is nothing here for a compromised client to rewrite.
   */
  decideAssistantPlan(id: string, planId: string, approve: boolean): Promise<PlanOutcome>;
  /** A name chosen by hand; the title generator never overwrites one. */
  renameAssistantSession(id: string, title: string): Promise<AssistantSession>;
  deleteAssistantSession(id: string): Promise<void>;

  // Listings beyond the folder tree. Trashed nodes never appear in `listFolder`, `listRecent`, `listStarred`, `listShared`.
  /** Files only, newest `openedAt` (falling back to `modifiedAt`) first. */
  listRecent(filter?: ListingFilter): Promise<Node[]>;
  listStarred(filter?: ListingFilter): Promise<Node[]>;
  /** Nodes other people shared with the current user (`sharedBy` / `sharedAt` set). */
  listShared(filter?: ListingFilter): Promise<Node[]>;
  /** Trashed nodes with `deletedAt` / `originalPath` set. */
  listTrash(filter?: ListingFilter): Promise<Node[]>;
  /** Every live folder of the storage, root included. One request per folder — see `listSubfolders`. */
  listFolders(storageId: string): Promise<Node[]>;
  /** The folders directly inside one folder, in one request. What the destination picker expands with. */
  listSubfolders(folderId: string): Promise<Node[]>;
  /**
   * Folders on one drive whose name matches, wherever they sit.
   *
   * The destination picker's filter box. Its tree is loaded a level at a time, so a filter over what happens to be
   * expanded would miss most of the drive; this asks the server the question instead.
   */
  searchFolders(storageId: string, text: string): Promise<Node[]>;

  // Mutations. Ids are validated; unknown ids throw. Name collisions reject with `DUPLICATE_NAME`.
  createFolder(parentId: string, name: string): Promise<Node>;
  /**
   * Uploads one file and resolves once the server holds every byte AND has written them to the storage.
   * `onProgress` fires per accepted chunk, so a caller can draw a bar that means something.
   */
  uploadFile(parentId: string, file: UploadInput, options?: UploadOptions): Promise<Node>;
  /** What the server still holds for a staged upload, or null once it has forgotten it (committed, aborted, expired). */
  uploadSession(id: string): Promise<UploadSession | null>;
  /** Carries a staged upload on from the offset the server reports. The bytes must be the same file it was begun for. */
  resumeUpload(id: string, parentId: string, file: UploadInput, options?: UploadOptions): Promise<Node>;
  /** Drops a staged upload: its staging area and its quota reservation go with it. */
  abortUpload(id: string): Promise<void>;
  rename(id: string, name: string): Promise<Node>;
  moveToTrash(ids: string[]): Promise<void>;
  restore(ids: string[]): Promise<void>;
  deleteForever(ids: string[]): Promise<void>;
  emptyTrash(): Promise<void>;
  setStarred(ids: string[], starred: boolean): Promise<void>;
  /** The node's tags as the server holds them — lower-cased, over-long ones dropped. */
  listTags(id: string): Promise<string[]>;
  /** Replaces the node's tag list; an empty array clears it. */
  setTags(id: string, tags: string[]): Promise<void>;
  move(ids: string[], targetFolderId: string): Promise<void>;
  /**
   * Server-side copy into `targetFolderId`, subtrees included. A name already taken there becomes
   * `<base>-copy<ext>`, then `-copy-2`, so pasting into the source's own folder duplicates rather than failing.
   */
  copy(ids: string[], targetFolderId: string): Promise<void>;
  createShareLink(id: string): Promise<string>;
  /**
   * The caller's own live public link to this node, or null when they have none. A listing row says THAT a node
   * is shared; the link itself is a credential the server hands out at a higher bar, so it is asked for per node,
   * when a panel that shows it opens.
   */
  shareLink(id: string): Promise<string | null>;
  removeShareLink(id: string): Promise<void>;
  /** Marks the file as opened now (`openedAt`), which moves it to the top of Recent. */
  recordOpen(id: string): Promise<void>;
}
