import type {
  Access,
  ActivityEvent,
  AssistantConversation,
  PlanOutcome,
  AssistantSession,
  AssistantContext,
  AssistantEvent,
  AuthMethods,
  AuthOptions,
  AssistantMode,
  Branding,
  Capabilities,
  ListingFilter,
  Node,
  NotifyPrefs,
  Person,
  ProfilePatch,
  Credentials,
  FolderListing,
  GroupOption,
  InviteOutcome,
  SearchQuery,
  SearchResult,
  Session,
  Storage,
  TotpEnrollment,
  UploadInput,
  UploadOptions,
  UploadSession,
  User,
  Version,
} from './types';

/** `createFolder` / `createFile` / `rename` reject with an Error carrying this message when a live sibling has the same name. */
export const DUPLICATE_NAME = 'duplicateName';
/** The node is there, but this account may not read it: a 403 rather than a 404, and a different sentence. */
export const FORBIDDEN = 'forbidden';
/** The server refused the name itself — "." or ".." or a separator in it — rather than the folder it would go in. */
export const INVALID_NAME = 'invalidName';

/** `changePassword` and `totpDisable` reject with this when the current password does not match. */
export const WRONG_PASSWORD = 'wrongPassword';

/** `totpVerify` and `totpDisable` reject with this when the authenticator (or recovery) code is not right. */
export const INVALID_CODE = 'invalidCode';

/**
 * `move` and `moveToTrash` reject with this when the server took the work but has not finished it yet: the job is
 * queued and running, so it is neither a success to report nor a failure to undo. Only the HTTP repository can
 * raise it — the mock does its work in memory and is always done.
 */
export const OPERATION_PENDING = 'operationPending';

/**
 * `resolvePath` rejects with an Error carrying this when the address names nothing this account can open.
 *
 * It exists so the caller can tell a folder that is GONE from a server that did not answer. Without it every
 * failure to resolve an address read as "this folder was renamed, moved or deleted" — a sentence about the
 * user's files that a dropped connection or a 500 gives nobody the right to say.
 *
 * A refusal (403) is reported the same way as a miss (404), on purpose: answering differently would confirm that
 * a folder the caller may not see exists.
 */
export const NOT_FOUND = 'notFound';

/**
 * `uploadFile`, `resumeUpload` and `commitUpload` reject with this when the server refused the target name with
 * `UploadOptions.ifExists: 'fail'` (`exists`), or because another session is uploading to the same target right now
 * (`inProgress`).
 *
 * A class rather than a message constant, on purpose: the store needs `phase` to know whether the bytes are already
 * staged — a refusal at `commit` is finished with `commitUpload(sessionId, …, { ifExists: 'replace' })` without
 * sending a byte again, while one at `begin` has no session and is re-uploaded — and `sessionId` to finish or drop
 * that session. Only a `commit` refusal carries one; at `begin` none was created.
 */
export class UploadConflict extends Error {
  constructor(
    readonly reason: 'exists' | 'inProgress',
    readonly phase: 'begin' | 'commit',
    readonly sessionId: string | null,
  ) {
    super(reason);
    this.name = 'UploadConflict';
  }
}

/**
 * Any mutation rejects with this when the caller's ROLE may not do it (403 `ROLE_FORBIDDEN`).
 *
 * Separate from an ordinary refusal because the sentence is different: nothing is wrong with the file, the folder
 * or the server — the person's role simply does not carry that operation, and only an administrator can change it.
 */
export const ROLE_FORBIDDEN = 'roleForbidden';

/**
 * `addPerson` rejects with this when the drive has access rules switched off altogether (409). Nothing about the
 * invite is wrong, so the modal says who can fix it instead of showing the server's own sentence about RBAC.
 */
export const RBAC_DISABLED = 'rbacDisabled';

/**
 * The account is out of room (413 `QUOTA_EXCEEDED`). A class of its own rather than the generic HTTP error it used
 * to be: measured on a stand with a quota configured, the tray said only "Upload failed", which sends somebody
 * looking for a network problem they do not have and cannot be corrected from anywhere else in the UI.
 *
 * It carries no numbers because the server sends none with this refusal — the sidebar's bar already states the
 * ceiling, and re-reading it here to decorate a message would be a second request on a failing path.
 */
export class QuotaExceeded extends Error {
  constructor() {
    super('quotaExceeded');
    this.name = 'QuotaExceeded';
  }
}

/**
 * The account may hold no more files (413 `FILE_LIMIT_EXCEEDED`). A class rather than a message, like
 * `UploadConflict`: the row has to print the ceiling, and a message constant cannot carry it.
 */
export class FileLimitExceeded extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super('fileLimitExceeded');
    this.name = 'FileLimitExceeded';
  }
}

/**
 * This account has uploaded its allowance for the current window (429 `UPLOAD_RATE_LIMITED`). `retryAfterSeconds`
 * is how long the server says to wait — the row re-queues itself after it rather than failing, because the transfer
 * is going to be accepted, just not yet.
 */
export class UploadRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('uploadRateLimited');
    this.name = 'UploadRateLimited';
  }
}

/** filex refuses anything shorter, so the form says so before a request goes out. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Why a sign-in was refused.
 *
 * `signIn` rejects with an Error carrying one of these rather than the server's own sentence, because the four
 * mean four different things to the person in front of the form: one is "try again", one is "and now the code",
 * and two are "there is nothing you can do here". filex answers all but the disabled one with 401, so the body is
 * what separates them — see backend/internal/api/handlers/auth.go.
 */
export const INVALID_CREDENTIALS = 'invalidCredentials';
/** The password was RIGHT and the second factor was missing or wrong; the form asks for the code. */
export const TOTP_REQUIRED = 'totpRequired';
export const ACCOUNT_DISABLED = 'accountDisabled';
/** Multi-tenant maintenance: only the platform operator may sign in right now. */
export const SIGN_IN_LIMITED = 'signInLimited';

export interface Repository {
  listStorages(): Promise<Storage[]>;
  getStorage(id: string): Promise<Storage>;
  /**
   * `filter` is applied by the repository, not by the caller: the HTTP one sends it as query params. The answer's
   * `total` is the folder's size before the filter, so the caller can decide to hold a small folder whole instead.
   */
  listFolder(folderId: string, filter?: ListingFilter): Promise<FolderListing>;
  /**
   * Folder at a slash-separated path relative to the storage root; "" resolves to the root.
   *
   * Rejects with `NOT_FOUND` when the address names nothing; every other rejection is a failure to reach the
   * server and must not be reported as a missing folder.
   */
  resolvePath(storageId: string, path: string): Promise<Node>;
  getNode(id: string): Promise<Node>;
  /** Root-to-node chain, root first, excluding the node itself. */
  getPath(id: string): Promise<Node[]>;
  /** Everyone — and every group — that can reach the node, plus whether this caller may change the list. */
  listPeople(nodeId: string): Promise<Access>;
  /**
   * Grants access to one principal: an account named by its address, or a group named by its id. `isDir` is the
   * node's own kind, which the server needs to know what the grant covers — it used to be hard-coded to `true`,
   * so every grant on a FILE was recorded as a grant on a folder.
   *
   * An address with no account behind it is not an error: filex mints a public link instead and says so in the
   * outcome's `mode`, and nobody is added to the list.
   */
  addPerson(nodeId: string, target: { email: string } | { groupId: string }, role: Person['role'], isDir: boolean): Promise<InviteOutcome>;
  /** Groups whose name matches, for the invite row's picker. */
  searchGroups(text: string): Promise<GroupOption[]>;
  /** `personId` is what `listPeople` handed back, so a `g:`-prefixed id addresses the group's grant. */
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
  /**
   * The account this browser is already signed in as, or null when it is signed in as nobody.
   *
   * Distinct from `currentUser`, which every screen calls and which throws for either reason: the router's guard
   * has to tell "no session" (send them to the form) from "the server is unreachable" (do not), and a caught
   * exception cannot say which it was without the data layer's own error shape leaking upwards.
   */
  session(): Promise<User | null>;
  /**
   * Signs in and answers with the account. Rejects with `INVALID_CREDENTIALS`, `TOTP_REQUIRED`,
   * `ACCOUNT_DISABLED` or `SIGN_IN_LIMITED`; anything else is a transport failure and reaches the caller as it is.
   */
  signIn(credentials: Credentials): Promise<User>;
  /** Ends this browser's session, server-side and in the cookie. Never rejects: local state is cleared regardless. */
  signOut(): Promise<void>;
  /** Which realms this installation offers, and the build — read by the sign-in screen before there is a session. */
  authOptions(): Promise<AuthOptions>;
  /**
   * Where to send the browser to start an SSO sign-in, or null when the installation has no IdP. A navigation and
   * not a request: the IdP owns the next few pages. `returnTo` is where filex lands the person afterwards.
   */
  oidcStartUrl(returnTo: string): string | null;
  /** Saves the account fields the settings modal owns and answers with the account as it now stands. */
  updateProfile(patch: ProfilePatch): Promise<User>;
  /** Rejects with `WRONG_PASSWORD` when `currentPassword` is not the account's. */
  /**
   * Where to point the browser to get `nodes` as one archive, or null when the server cannot zip. A URL builder
   * rather than a request: the download has to be a navigation, so the browser owns the save dialog, the progress
   * and the disk write instead of the page holding the whole archive in memory.
   */
  archiveUrl(nodes: Node[]): string | null;
  /**
   * Where the browser can fetch a file's bytes for an inline picture, or undefined when it has none. A URL builder
   * for the same reason as `archiveUrl`: a plan lists files by address alone, and a thumbnail per line must not cost
   * a request per line.
   */
  previewUrl(id: string): string | undefined;
  /**
   * Where to point the browser to save a file, or undefined when it has no bytes to save. The data layer's job and
   * not a helper's: filex serves a download from the same manager endpoint as a preview but under a different verb,
   * while the demo's files are static assets — so "the preview address plus a flag" is only true of the demo, and
   * against a real server it produced a second `?` INSIDE the query, which the server read as part of the path.
   */
  downloadUrl(id: string): string | undefined;

  /** How this account signs in, and what it may change here: the Security card asks before it offers anything. */
  authMethods(): Promise<AuthMethods>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /**
   * Starts a second-factor enrolment: a fresh secret, its QR and the recovery codes. Nothing is switched on until
   * `totpVerify` proves the authenticator holds the secret; asking again replaces the pending one.
   */
  totpEnroll(): Promise<TotpEnrollment>;
  /** Confirms the pending enrolment and switches the second factor on. Rejects with `INVALID_CODE`. */
  totpVerify(code: string): Promise<void>;
  /**
   * Switches the second factor off. Both proofs are asked for: rejects with `WRONG_PASSWORD` or `INVALID_CODE`,
   * in that order — the server checks the password first. `code` may be a recovery code.
   */
  totpDisable(password: string, code: string): Promise<void>;
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
  /** The operator's name, mark and accent for this installation; read once at start-up. */
  branding(): Promise<Branding>;
  search(query: SearchQuery): Promise<SearchResult>;
  /**
   * Streams the assistant's answer to `prompt`; aborting `signal` ends the stream early. `conversationId` is the
   * conversation this turn belongs to — against a live server that is the stored session, which is where the
   * question and the answer are both written, so a turn without one has nowhere to go.
   */
  assistantAsk(prompt: string, mode: AssistantMode, conversationId: string | null, signal: AbortSignal, context?: AssistantContext): AsyncIterable<AssistantEvent>;
  /**
   * Streams a turn nobody typed: the executor has just written what a plan did and the assistant is let back in to
   * deal with what it left undone. Nothing is added to the conversation for it — the note is already the last thing
   * in it — and the server refuses the call unless that is still true.
   */
  assistantResume(conversationId: string, signal: AbortSignal): AsyncIterable<AssistantEvent>;

  // The assistant's history. Private to the account: the server has no route that hands one person's conversation
  // to anybody else, an administrator included.
  /** Most recently active first — the order the list is drawn in and the order eviction reads from the far end. */
  listAssistantSessions(): Promise<AssistantSession[]>;
  /**
   * How many conversations the account may keep, as the session listing states it (`max` in its answer). A number
   * the server owns and has always sent; the panel used to print a constant of its own beside the count, which is
   * only right until an install changes the limit. Reads what the last listing said, so ask after listing.
   */
  assistantSessionMax(): number;
  /** Starts one. Reaching the per-account cap evicts the least recently active session rather than refusing. */
  createAssistantSession(title?: string): Promise<AssistantSession>;
  /** The turns of one conversation, plus the files it has been given permission to open. */
  assistantMessages(id: string): Promise<AssistantConversation>;
  /**
   * Answers the request to read ONE file in this conversation: the turn waiting at the card goes on with the
   * contents or with a refusal. There is no form of this call that approves a folder, a pattern or everything —
   * that is the rule it exists to keep.
   */
  decideAssistantRead(id: string, path: string, allow: boolean): Promise<void>;
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
  /** An empty file under `parentId`; the same collision rule as `createFolder`, against files and folders alike. */
  createFile(parentId: string, name: string): Promise<Node>;
  /**
   * Uploads one file and resolves once the server holds every byte AND has written them to the storage.
   * `onProgress` fires per accepted chunk, so a caller can draw a bar that means something.
   */
  uploadFile(parentId: string, file: UploadInput, options?: UploadOptions): Promise<Node>;
  /** What the server still holds for a staged upload, or null once it has forgotten it (committed, aborted, expired). */
  uploadSession(id: string): Promise<UploadSession | null>;
  /** Carries a staged upload on from the offset the server reports. The bytes must be the same file it was begun for. */
  resumeUpload(id: string, parentId: string, file: UploadInput, options?: UploadOptions): Promise<Node>;
  /**
   * Finishes a session whose every byte is staged but whose commit was refused (`UploadConflict` with phase
   * `commit`): commits it again with `options.ifExists`, waits for the write and answers with the node. The session
   * stays committable after a refusal, so no byte travels twice.
   */
  commitUpload(sessionId: string, parentId: string, name: string, options?: UploadOptions): Promise<Node>;
  /** Drops a staged upload: its staging area and its quota reservation go with it. */
  abortUpload(id: string): Promise<void>;
  rename(id: string, name: string): Promise<Node>;
  /**
   * The three queued verbs (`moveToTrash`, `move`, `copy`) submit a job and then wait on it. `signal` gives that
   * wait up: the job is on the server and carries on, so the call then rejects with `OPERATION_PENDING` like any
   * other wait that ended without an answer.
   */
  moveToTrash(ids: string[], signal?: AbortSignal): Promise<void>;
  restore(ids: string[]): Promise<void>;
  deleteForever(ids: string[]): Promise<void>;
  emptyTrash(): Promise<void>;
  setStarred(ids: string[], starred: boolean): Promise<void>;
  /** The node's tags as the server holds them — lower-cased, over-long ones dropped. */
  listTags(id: string): Promise<string[]>;
  /** Every distinct tag on the drives this account can see, alphabetical. What the tag chip's menu offers. */
  listAllTags(): Promise<string[]>;
  /** Replaces the node's tag list; an empty array clears it. */
  setTags(id: string, tags: string[]): Promise<void>;
  move(ids: string[], targetFolderId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Server-side copy into `targetFolderId`, subtrees included. A name already taken there becomes
   * `<base>-copy<ext>`, then `-copy-2`, so pasting into the source's own folder duplicates rather than failing.
   */
  copy(ids: string[], targetFolderId: string, signal?: AbortSignal): Promise<void>;
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
