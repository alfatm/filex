package db

import (
	"context"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/model"
)

// NodeAgg is a lightweight node row used for folder-size aggregation
// (internal/sync.RecomputeFolderSizes): just enough to walk the tree and sum
// descendant file sizes into each folder's cached size.
type NodeAgg struct {
	ID       int64
	ParentID *int64
	IsDir    bool
	Size     int64
	// Mtime is the node's backend_mtime (nullable). For folders it feeds the
	// "last activity" date = newest descendant mtime (see RecomputeFolderSizes).
	Mtime *time.Time
}

// Store is the interface implemented by every dialect-specific query
// adapter. Methods are intentionally tiny domain operations — handlers
// should never reach into *sql.DB directly.
//
// In a fully-generated setup this surface would be sqlc's Querier
// interface; here we hand-roll it so the skeleton compiles without a
// `sqlc generate` step.
type Store interface {
	// Lifecycle
	Ping(ctx context.Context) error
	Close() error

	// Storages
	CreateStorage(ctx context.Context, s *model.Storage) (*model.Storage, error)
	GetStorage(ctx context.Context, id int64) (*model.Storage, error)
	GetStorageByName(ctx context.Context, name string) (*model.Storage, error)
	ListStorages(ctx context.Context) ([]*model.Storage, error)
	ListEnabledStorages(ctx context.Context) ([]*model.Storage, error)
	UpdateStorage(ctx context.Context, s *model.Storage) error
	UpdateStorageSyncCursor(ctx context.Context, id int64, at time.Time, token string) error
	DeleteStorage(ctx context.Context, id int64) error

	// Nodes
	CreateNode(ctx context.Context, n *model.Node) (*model.Node, error)
	GetNode(ctx context.Context, id int64) (*model.Node, error)
	GetNodeByPath(ctx context.Context, storageID int64, pathHash string) (*model.Node, error)
	// GetNodeByPathIncludingDeleted answers "is there ANY row at this path",
	// live or trashed. The sync worker asks it so that an object appearing
	// where a trashed row still sits is reported rather than silently
	// conflated with it.
	//
	// Since migration 00032 the unique index over (storage_id, path_hash) is
	// partial on live rows, so several trashed rows may share a path with at
	// most one live one. Implementations MUST return the live row when there
	// is one, and otherwise the most recently trashed row -- an arbitrary
	// pick would make the sync's decision depend on row order.
	GetNodeByPathIncludingDeleted(ctx context.Context, storageID int64, pathHash string) (*model.Node, error)
	// ListLiveNodesInTrash returns every LIVE node of a storage whose path is
	// the trash bucket or sits inside it. Nothing should ever be live in
	// there: it is either a trashed item an older sync worker un-deleted, or
	// a row that same worker minted for the trash's own bytes. The sync pass
	// uses it to clear both up. trashPrefix is given without a leading slash
	// (`trash.Prefix`); implementations match the stored path with and
	// without one, because drivers differ on that.
	ListLiveNodesInTrash(ctx context.Context, storageID int64, trashPrefix string) ([]*model.Node, error)
	ListNodesByParent(ctx context.Context, storageID int64, parentID *int64) ([]*model.Node, error)
	// AggNodes returns a lightweight {id, parent_id, is_dir, size} row for every
	// live node of a storage — the input to folder-size aggregation.
	AggNodes(ctx context.Context, storageID int64) ([]NodeAgg, error)
	// SetNodeSize overwrites a node's cached size. Used to store recursive folder
	// totals (see internal/sync.RecomputeFolderSizes).
	SetNodeSize(ctx context.Context, id int64, size int64) error
	// SetNodeMtime overwrites a node's cached backend_mtime. Used to give folders
	// a "last activity" date (newest descendant mtime) so the explorer can show a
	// date for directories whose driver reports none (e.g. synthetic S3 prefixes).
	SetNodeMtime(ctx context.Context, id int64, mtime *time.Time) error
	UpdateNodeMeta(ctx context.Context, id int64, size int64, mime, etag string, mtime time.Time) error
	TouchNodeSeen(ctx context.Context, id int64) error
	SoftDeleteNode(ctx context.Context, id int64) error
	// SoftDeleteAndRetag flips deleted_at + rewrites path/path_hash to a
	// trash key in one shot, while saving the original path in
	// storage_key. Used by vfDelete after the on-disk rename so the
	// original-path slot is freed (UNIQUE(storage_id, path_hash)).
	SoftDeleteAndRetag(ctx context.Context, id int64, trashPath, trashHash, origPath string) error
	HardDeleteNode(ctx context.Context, id int64) error
	MoveNode(ctx context.Context, id int64, parentID *int64, name, path, pathHash string) error
	ListStaleNodes(ctx context.Context, storageID int64, before time.Time) ([]*model.Node, error)
	CountNodesByStorage(ctx context.Context, storageID int64) (int64, error)

	// Replication targets — separate entity. Storages.replica_target_id
	// is the FK linking a primary to one of these.
	ListReplicationTargets(ctx context.Context) ([]*model.ReplicationTarget, error)
	GetReplicationTarget(ctx context.Context, id int64) (*model.ReplicationTarget, error)
	CreateReplicationTarget(ctx context.Context, rt *model.ReplicationTarget) (*model.ReplicationTarget, error)
	UpdateReplicationTarget(ctx context.Context, rt *model.ReplicationTarget) error
	DeleteReplicationTarget(ctx context.Context, id int64) error
	// StorageStats returns (file_count, total_size_bytes) for a storage,
	// excluding directories and soft-deleted nodes. Used by the admin
	// storages list page so each row can show "N files, 1.2 GB" without
	// the SPA looping every node row.
	StorageStats(ctx context.Context, storageID int64) (fileCount int64, totalBytes int64, err error)
	SearchNodes(ctx context.Context, storageID int64, like string, limit int) ([]*model.Node, error)
	// ListNodeIDsMatching answers "which nodes have these properties" — the
	// facet half of a search, which the full-text index cannot express because
	// its documents carry no size, date or owner. The ids come back so the
	// index can be RESTRICTED to them, the same mechanism a `tag:` filter uses;
	// `limit` is a ceiling on the set, and a truncated set is reported by the
	// caller rather than silently narrowing the search.
	ListNodeIDsMatching(ctx context.Context, storageID int64, f NodeFacets, limit int) ([]int64, error)

	// Users
	CreateUser(ctx context.Context, email, passwordHash, role, locale, tz string) (*model.User, error)
	GetUser(ctx context.Context, id int64) (*model.User, error)
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	// Dual-side login (migration 00025): an account answers to its e-mail or
	// its username. Reach these through identity.Resolve, not directly — the
	// rule for deciding which one an identifier is belongs in one place.
	GetUserByUsername(ctx context.Context, username string) (*model.User, error)
	SetUserUsername(ctx context.Context, id int64, username string) error
	// Multi-tenancy (docs/MULTI-TENANCY.md): look a user up within one provider
	// (tenant); re-home a user to a provider + record its OIDC subject (JIT).
	GetUserByProviderEmail(ctx context.Context, providerID int64, email string) (*model.User, error)
	SetUserProvider(ctx context.Context, userID, providerID int64, oidcSubject string) error
	ListUsersByProvider(ctx context.Context, providerID int64) ([]*model.User, error)
	ListUsers(ctx context.Context) ([]*model.User, error)
	CountUsers(ctx context.Context) (int64, error)
	UpdateUserPassword(ctx context.Context, id int64, hash string) error
	UpdateUserEmail(ctx context.Context, id int64, email string) error
	UpdateUserDisplayName(ctx context.Context, id int64, displayName string) error
	// UpdateUserAvatar sets (or clears, with "") the profile picture — a small
	// data: URI or an http(s)/site-relative URL. Validation lives at the API
	// boundary; the store only persists what it is handed.
	UpdateUserAvatar(ctx context.Context, id int64, avatarURL string) error
	UpdateUserLocale(ctx context.Context, id int64, locale, tz string) error
	UpdateUserRole(ctx context.Context, id int64, role string) error
	TouchLastLogin(ctx context.Context, id int64) error
	DeleteUser(ctx context.Context, id int64) error

	// TOTP / 2FA
	SetTotpPendingSecret(ctx context.Context, id int64, secret string, recoveryCodes []string) error
	ActivateTotp(ctx context.Context, id int64) error
	ClearTotp(ctx context.Context, id int64) error

	// Sessions
	CreateSession(ctx context.Context, userID int64, token string, expiresAt time.Time, ip, ua string) (*model.Session, error)
	GetSessionByToken(ctx context.Context, token string) (*model.Session, error)
	// UpdateUserProfileFields writes the optional full name and job title (migration 00035).
	UpdateUserProfileFields(ctx context.Context, id int64, fullName, jobTitle string) error
	// ListSessionsForUser returns the user's own unexpired sessions, newest first — the
	// list behind "where am I signed in".
	ListSessionsForUser(ctx context.Context, userID int64) ([]*model.Session, error)
	// DeleteUserSession ends one session of that user. The user id is part of the WHERE, so
	// the worst a caller can do with somebody else's session id is delete nothing; the bool
	// says whether a row was actually there.
	DeleteUserSession(ctx context.Context, userID, sessionID int64) (bool, error)
	DeleteSession(ctx context.Context, token string) error
	DeleteSessionsForUser(ctx context.Context, userID int64, exceptToken string) error
	CountActiveSessions(ctx context.Context) (int64, error)
	DeleteExpiredSessions(ctx context.Context) error

	// API tokens — long-lived bearer credentials for AI / MCP / FilexClient.
	CreateAPIToken(ctx context.Context, t *model.APIToken) (*model.APIToken, error)
	GetAPITokenByHash(ctx context.Context, tokenHash string) (*model.APIToken, error)
	GetAPITokenByID(ctx context.Context, id int64) (*model.APIToken, error)
	ListAPITokens(ctx context.Context) ([]*model.APIToken, error)
	ListAPITokensByUser(ctx context.Context, userID int64) ([]*model.APIToken, error)
	TouchAPIToken(ctx context.Context, id int64) error
	// UpdateAPITokenMeta edits a token's display metadata (label / username
	// allow-list) and its kind ("user" / "app", migration 00030); nil leaves a
	// field unchanged. The credential itself is immutable.
	//
	// Kind is editable because migration 00030 defaults every pre-existing row
	// to "app": a personal token minted before the split needs one admin edit
	// to become a "user" token again.
	UpdateAPITokenMeta(ctx context.Context, id int64, label, usernames, kind *string) error
	DeleteAPIToken(ctx context.Context, id int64) error

	// S3 access keys (migration 00026) — the credential an S3 client signs
	// with. Unlike an API token these hold a RECOVERABLE secret, because SigV4
	// verifies by recomputing an HMAC chain rather than by comparing a hash;
	// internal/secretbox is what keeps that out of a database dump. A key
	// minted from a token INHERITS that token's permissions and never widens
	// them (see model.S3AccessKey).
	CreateS3AccessKey(ctx context.Context, k *model.S3AccessKey) (*model.S3AccessKey, error)
	GetS3AccessKey(ctx context.Context, accessKeyID string) (*model.S3AccessKey, error)
	GetS3AccessKeyByID(ctx context.Context, id int64) (*model.S3AccessKey, error)
	ListS3AccessKeys(ctx context.Context, userID int64) ([]*model.S3AccessKey, error)
	TouchS3AccessKey(ctx context.Context, id int64) error
	SetS3AccessKeyDisabled(ctx context.Context, id int64, disabled bool) error
	DeleteS3AccessKey(ctx context.Context, id, userID int64) error

	// SSH public keys (migration 00027) — how an account reaches the SFTP
	// endpoint without sending a password. The signature is verified by
	// x/crypto/ssh before any of these are called; what the lookup decides is
	// which ACCOUNT the key belongs to, which is why GetSSHPublicKey takes a
	// fingerprint and returns exactly one row.
	CreateSSHPublicKey(ctx context.Context, k *model.SSHPublicKey) (*model.SSHPublicKey, error)
	GetSSHPublicKey(ctx context.Context, fingerprint string) (*model.SSHPublicKey, error)
	GetSSHPublicKeyByID(ctx context.Context, id int64) (*model.SSHPublicKey, error)
	ListSSHPublicKeys(ctx context.Context, userID int64) ([]*model.SSHPublicKey, error)
	TouchSSHPublicKey(ctx context.Context, id int64) error
	SetSSHPublicKeyDisabled(ctx context.Context, id int64, disabled bool) error
	DeleteSSHPublicKey(ctx context.Context, id, userID int64) error

	// NFS exports (migration 00028) — an NFSv3 mount bound to one account by a
	// high-entropy export PATH, because NFSv3 has no authentication filex can
	// use. GetNFSExport takes the sha256 of that path: the server only ever
	// compares, so the plaintext is never stored.
	CreateNFSExport(ctx context.Context, e *model.NFSExport) (*model.NFSExport, error)
	GetNFSExport(ctx context.Context, tokenHash string) (*model.NFSExport, error)
	GetNFSExportByID(ctx context.Context, id int64) (*model.NFSExport, error)
	ListNFSExports(ctx context.Context, userID int64) ([]*model.NFSExport, error)
	TouchNFSExport(ctx context.Context, id int64) error
	SetNFSExportDisabled(ctx context.Context, id int64, disabled bool) error
	DeleteNFSExport(ctx context.Context, id, userID int64) error

	// Storage plugins (migration 00029) — the admin's registration of an
	// out-of-process storage driver; see internal/plugin. Runtime state is
	// NOT here (the manager re-derives it by starting the plugin).
	CreatePlugin(ctx context.Context, p *model.Plugin) (*model.Plugin, error)
	GetPlugin(ctx context.Context, id int64) (*model.Plugin, error)
	GetPluginByName(ctx context.Context, name string) (*model.Plugin, error)
	ListPlugins(ctx context.Context) ([]*model.Plugin, error)
	UpdatePlugin(ctx context.Context, p *model.Plugin) error
	DeletePlugin(ctx context.Context, id int64) error

	// File grants — per-user/per-folder ACL (RBAC feature, migration 00012).
	ListFileGrantsByStorageUser(ctx context.Context, storageID, userID int64) ([]*model.FileGrant, error)
	ListFileGrantsByStorage(ctx context.Context, storageID int64) ([]*model.FileGrant, error)
	ListAllFileGrants(ctx context.Context) ([]*model.FileGrant, error)
	GetFileGrant(ctx context.Context, id int64) (*model.FileGrant, error)
	CreateFileGrant(ctx context.Context, g *model.FileGrant) (*model.FileGrant, error)
	UpdateFileGrantLevel(ctx context.Context, id int64, level string) error
	DeleteFileGrant(ctx context.Context, id int64) error

	// Shares
	CreateShare(ctx context.Context, share *model.Share) (*model.Share, error)
	GetShareByID(ctx context.Context, id int64) (*model.Share, error)
	GetShareByToken(ctx context.Context, token string) (*model.Share, error)
	ListSharesByNode(ctx context.Context, nodeID int64) ([]*model.Share, error)
	ListAllShares(ctx context.Context, creatorID *int64, activeOnly bool, limit, offset int) ([]*ShareWithMeta, int64, error)
	RevokeShare(ctx context.Context, id int64) error
	IncrementShareDownload(ctx context.Context, id int64) error
	// ReserveShareDownload claims ONE download against the link's cap and
	// reports whether it got one. This is the cap's only real enforcement
	// point: a check that reads the counter and a serve that bumps it
	// afterwards are two separate steps, and every request that starts inside
	// that gap passes the check (measured on fm.example.com: a 1-download link
	// handed three full files to three overlapping clients). Claim, then serve.
	ReserveShareDownload(ctx context.Context, id int64) (bool, error)
	// ReleaseShareDownload hands a reserved slot back. Used only when the serve
	// fails before a single byte reaches the client, so a storage error does
	// not silently eat one of the downloads the owner granted.
	ReleaseShareDownload(ctx context.Context, id int64) error
	IncrementShareUpload(ctx context.Context, id int64, n int) error
	DeleteShare(ctx context.Context, id int64) error
	DeleteExpiredShares(ctx context.Context) error

	// Chunked uploads
	CreateChunkedUpload(ctx context.Context, u *model.ChunkedUpload) error
	GetChunkedUpload(ctx context.Context, id string) (*model.ChunkedUpload, error)
	UpdateChunkedUploadParts(ctx context.Context, id string, parts []model.UploadPart) error
	DeleteChunkedUpload(ctx context.Context, id string) error
	DeleteExpiredChunkedUploads(ctx context.Context) error

	// Staged uploads — the driver-agnostic resumable path (docs/UPLOADS.md).
	// A separate table from chunked_uploads on purpose: see the comment in
	// db/migrations/sqlite/00024_staged_uploads.sql.
	CreateStagedUpload(ctx context.Context, u *model.StagedUpload) error
	GetStagedUpload(ctx context.Context, id string) (*model.StagedUpload, error)
	// GetStagedUploadByNode is the reverse index chunk 5 (read-during-transfer)
	// uses to find the staging directory holding a node's bytes.
	GetStagedUploadByNode(ctx context.Context, nodeID int64) (*model.StagedUpload, error)
	UpdateStagedUploadProgress(ctx context.Context, id string, receivedBytes int64) error
	UpdateStagedUploadState(ctx context.Context, id, state, errMsg string) error
	AttachStagedUploadTarget(ctx context.Context, id string, nodeID, opID int64) error
	DeleteStagedUpload(ctx context.Context, id string) error
	ListStagedUploads(ctx context.Context, state string, limit int) ([]*model.StagedUpload, error)
	// ListIdleStagedUploads returns rows whose last activity is older than
	// `before` — the staging sweeper's input.
	ListIdleStagedUploads(ctx context.Context, before time.Time, limit int) ([]*model.StagedUpload, error)
	// SumOpenStagedUploadBytes is the quota RESERVATION: the declared size of
	// every not-yet-committed upload the user owns. Derived rather than stored,
	// so it can never drift from the rows it describes and a row leaving the
	// open set releases its reservation by construction.
	SumOpenStagedUploadBytes(ctx context.Context, userID int64) (int64, error)

	// SetNodeTransferState sets nodes.transfer_state: "staged" while the bytes
	// are in filex's staging area, "stored" once they are on the driver, and
	// "failed" when the transfer to the driver did not succeed.
	SetNodeTransferState(ctx context.Context, nodeID int64, state string) error

	// Sync runs / conflicts
	CreateSyncRun(ctx context.Context, storageID int64, cursorBefore string) (*model.SyncRun, error)
	FinishSyncRun(ctx context.Context, id int64, cursorAfter string, seen, added, updated, deleted int, status, errMsg string) error
	GetSyncRun(ctx context.Context, id int64) (*model.SyncRun, error)
	GetLastSyncRun(ctx context.Context, storageID int64) (*model.SyncRun, error)
	ListSyncRuns(ctx context.Context, storageID int64, limit int) ([]*model.SyncRun, error)
	ListSyncRunsAcrossAll(ctx context.Context, storageID int64, status string, limit, offset int) ([]*model.SyncRun, int64, error)
	CreateSyncConflict(ctx context.Context, c *model.SyncConflict) error
	ListUnresolvedConflicts(ctx context.Context) ([]*model.SyncConflict, error)
	ListConflictsByStorage(ctx context.Context, storageID int64, limit int) ([]*model.SyncConflict, error)
	CountSyncConflictsByRun(ctx context.Context, runID int64) (int64, error)
	ResolveConflict(ctx context.Context, id int64, resolution string) error
	CountQueueDepth(ctx context.Context) (int64, error)

	// Audit
	InsertAuditEntry(ctx context.Context, e *model.AuditEntry) error
	ListAuditRecent(ctx context.Context, limit int) ([]*model.AuditEntry, error)
	ListAuditFiltered(ctx context.Context, userID *int64, action string, from, to *time.Time, limit, offset int) ([]*AuditEntryWithUser, int64, error)

	// Assistant sessions and messages.
	//
	// The split is the privacy rule made structural: session rows are metadata
	// an administrator may list, message rows are the conversation and only the
	// owner ever reads them. There is deliberately no store method that returns
	// another user's messages — not a filtered one, none.
	CreateAssistantSession(ctx context.Context, s *model.AssistantSession) (*model.AssistantSession, error)
	// ListAssistantSessions returns one user's sessions, most recently active
	// first — which is also the order eviction reads from the other end.
	ListAssistantSessions(ctx context.Context, userID int64, limit int) ([]*model.AssistantSession, error)
	GetAssistantSession(ctx context.Context, id int64) (*model.AssistantSession, error)
	// SetAssistantSessionTitle records a title; manual marks it as chosen by a
	// person, which stops the generator from replacing it later.
	SetAssistantSessionTitle(ctx context.Context, id int64, title string, manual bool) error
	// DeleteAssistantSession removes a conversation and everything scoped to
	// it — messages, read grants, plans — atomically. The grants are the
	// person's consent to open named files and do not outlive the conversation
	// they were given in.
	DeleteAssistantSession(ctx context.Context, id int64) error
	// EvictAssistantSessions drops everything past `keep` for this user, oldest
	// by LAST ACTIVITY, and answers with how many it removed. Ordering by
	// creation would evict the conversation somebody returns to every week.
	EvictAssistantSessions(ctx context.Context, userID int64, keep int) (int, error)
	// AppendAssistantMessage stores one turn and moves the session's activity
	// stamp and message count with it — one call, so a stored message can never
	// leave the session looking untouched.
	AppendAssistantMessage(ctx context.Context, m *model.AssistantMessage) (*model.AssistantMessage, error)
	ListAssistantMessages(ctx context.Context, sessionID int64) ([]*model.AssistantMessage, error)
	// GrantAssistantRead records the person's permission to read ONE file's
	// contents inside ONE conversation. Repeating a grant is not an error —
	// the same file approved twice is one permission.
	//
	// ⚠ There is no revoke and no wildcard on purpose. Consent ends with the
	// conversation (the rows cascade with it), and a form that could express
	// "everything" is the one the owner ruled out.
	GrantAssistantRead(ctx context.Context, sessionID int64, path string) error
	// AssistantReadGranted answers the read tool's only question: may this
	// conversation open this exact path.
	AssistantReadGranted(ctx context.Context, sessionID int64, path string) (bool, error)
	// ListAssistantReadGrants is what the panel redraws its approvals from
	// when a stored conversation is reopened.
	ListAssistantReadGrants(ctx context.Context, sessionID int64) ([]string, error)
	// CreateAssistantPlan stores proposed work. It is created pending and is
	// the only thing the executor will act on — the model's tool call wrote
	// this row and then stopped being involved.
	CreateAssistantPlan(ctx context.Context, p *model.AssistantPlan) (*model.AssistantPlan, error)
	GetAssistantPlan(ctx context.Context, id int64) (*model.AssistantPlan, error)
	ListAssistantPlans(ctx context.Context, sessionID int64) ([]*model.AssistantPlan, error)
	// ClaimAssistantPlan takes a pending plan for execution and reports whether
	// this caller is the one that got it.
	//
	// ⚠⚠ This — not FinishAssistantPlan — is what makes a plan run at most
	// once. Closing the row afterwards is too late: two approvals racing (a
	// double click, a retried request, two tabs) both read `pending`, both do
	// the work, and only then does one of them lose the update — by which time
	// a create_share plan has minted two public links and shown one of them to
	// nobody. So the claim happens BEFORE the first item runs.
	//
	// The claim is `decided_at`, not a new status: the row stays `pending`
	// while it runs, so FinishAssistantPlan closes it exactly as before and no
	// status value the interface does not know ever reaches it. A plan whose
	// execution died half-way is therefore pending with a decided_at, which is
	// refused rather than run again — the safe way round, since what it did
	// before it died is not known.
	ClaimAssistantPlan(ctx context.Context, id int64) (bool, error)
	// FinishAssistantPlan records the outcome and closes the plan. It moves the
	// row out of `pending` ONLY while it is still pending, and reports whether
	// it did.
	FinishAssistantPlan(ctx context.Context, id int64, status, resultJSON string) (bool, error)
	// CountAssistantSessions is the admin overview's figure: how many
	// conversations an account holds, never what is in them.
	CountAssistantSessions(ctx context.Context, userID int64) (int, error)

	// Settings
	GetSetting(ctx context.Context, key string) (string, error)
	UpsertSetting(ctx context.Context, key, value string) error
	ListSettings(ctx context.Context) (map[string]string, error)

	// External services
	UpsertExternalService(ctx context.Context, name string, enabled bool, url, secretEnc, optionsJSON string, lastCheck time.Time, lastState string) error
	GetExternalService(ctx context.Context, name string) (*ExternalService, error)
	ListExternalServices(ctx context.Context) ([]*ExternalService, error)
	UpdateExternalServiceState(ctx context.Context, name string, lastCheck time.Time, state string) error

	// Duplicate report — every live file node whose (size, non-empty etag)
	// pair occurs more than once, minSize filtering applied in SQL. Rows come
	// back ordered (size DESC, etag, id) so the handler can group them
	// contiguously. Powers GET /api/admin/duplicates (v0.2 "Bul").
	ListDuplicateNodes(ctx context.Context, minSize int64) ([]DuplicateNode, error)

	// Cross-storage analytics for the dashboard
	SumNodesBytesByStorage(ctx context.Context, storageID int64) (int64, error)
	CountNodesAddedSince(ctx context.Context, storageID int64, since time.Time) (int64, error)
	CountNodesDeletedSince(ctx context.Context, storageID int64, since time.Time) (int64, error)
	CountTotalShares(ctx context.Context) (int64, error)

	// Thumbnails
	GetThumbnail(ctx context.Context, nodeID int64) (*model.Thumbnail, error)
	UpsertThumbnail(ctx context.Context, t *model.Thumbnail) error
	SetThumbnailState(ctx context.Context, nodeID int64, state, errMsg string) error
	// DeleteThumbnail drops the row for one node. The cached JPEG on disk is
	// the pipeline's business (internal/thumb); this is only the catalogue
	// half, and it exists so a purge does not have to wait for the FK cascade
	// to be the only thing that ever removed it.
	DeleteThumbnail(ctx context.Context, nodeID int64) error
	// PurgeThumbnails drops every thumbnails row in scope — one storage when
	// storageID > 0, the whole installation when 0 — and returns the node ids
	// whose rows were removed so the caller can delete their cached JPEGs.
	//
	// The catalogue half only, like DeleteThumbnail: nothing here touches the
	// cache directory. See thumb.Pipeline.Reset for the operation an admin
	// actually triggers.
	PurgeThumbnails(ctx context.Context, storageID int64) ([]int64, error)
	// ExistingNodeIDs reports which of the given ids still have a `nodes` row —
	// TRASHED ROWS INCLUDED, because a trashed file is restorable and must keep
	// its thumbnail. It is the safety interlock of the thumbnail-cache sweeper:
	// a cached file is deleted only when this positively says its node is gone.
	ExistingNodeIDs(ctx context.Context, ids []int64) (map[int64]bool, error)

	// Node versions
	CreateNodeVersion(ctx context.Context, v *model.NodeVersion) (*model.NodeVersion, error)
	ListNodeVersions(ctx context.Context, nodeID int64) ([]*model.NodeVersion, error)
	GetNodeVersion(ctx context.Context, id int64) (*model.NodeVersion, error)
	NextNodeVersionNumber(ctx context.Context, nodeID int64) (int, error)
	DeleteNodeVersion(ctx context.Context, id int64) error
	DeleteOldNodeVersions(ctx context.Context, nodeID int64, keep int) ([]*model.NodeVersion, error)
	// ListNodeIDsWithVersions returns the distinct node ids that have at
	// least one node_versions row — the work list for the daily version
	// retention job (v0.4 "Koru").
	ListNodeIDsWithVersions(ctx context.Context) ([]int64, error)

	// Sync conflicts (admin views)
	ListSyncConflictsByRun(ctx context.Context, runID int64) ([]*model.SyncConflict, error)
	ListSyncConflictsByStorage(ctx context.Context, storageID int64, limit int) ([]*model.SyncConflict, error)

	// Search rebuild
	AllNodesForIndex(ctx context.Context) ([]*model.Node, error)

	// Quota
	GetUserUsage(ctx context.Context, userID int64) (used, limit int64, err error)
	IncrementUserUsage(ctx context.Context, userID int64, delta int64) error
	SetUserQuota(ctx context.Context, userID int64, bytes int64) error
	// SetUserEnabled flips the account on/off (migration 00022). A disabled
	// user cannot start a session; nothing they own is touched.
	SetUserEnabled(ctx context.Context, userID int64, enabled bool) error
	RecomputeUserUsage(ctx context.Context, userID int64) (int64, error)

	// Node owner
	SetNodeOwner(ctx context.Context, nodeID int64, ownerID *int64) error
	GetNodeOwner(ctx context.Context, nodeID int64) (*int64, error)
	// NodeOwners answers for a whole listing at once, already joined to the
	// account's name. GetNodeOwner per row would be one query per file, and it
	// would still leave the caller holding a number nobody can read.
	//
	// ⚠ Name means DISPLAY NAME, and is empty for an account that has set none.
	// The e-mail is never a fallback for it: this row is drawn for everybody who
	// may see the listing.
	NodeOwners(ctx context.Context, nodeIDs []int64) ([]NodeOwner, error)

	// Listing enrichment — one query for a whole page, keyed by node id.
	//
	// ChildCounts counts the LIVE children of each parent, minus the internal
	// buckets a listing hides (.filex-trash, .versions, .thumbs, the E2E
	// marker), so the number matches what the same listing would show. Parents
	// with no children are absent rather than carried as a zero.
	ChildCounts(ctx context.Context, parentIDs []int64) (map[int64]int64, error)
	// SharedNodeIDs answers which of these nodes currently have a public link
	// somebody could still open — the same liveness test model.Share.IsExpired
	// applies to one share, asked of many nodes at once.
	SharedNodeIDs(ctx context.Context, nodeIDs []int64) ([]int64, error)
	// StorageUsage sums the bytes each of these drives holds, as the index knows
	// them: every file row, trashed ones included, because a file in the trash is
	// still on the driver. Directory rows are excluded — they carry an aggregate
	// of their subtree and would count everything twice.
	StorageUsage(ctx context.Context, storageIDs []int64) (map[int64]int64, error)

	// Trash retention
	ListTrashedExpired(ctx context.Context, before time.Time, limit int) ([]*model.Node, error)
	// ListTrashed returns soft-deleted nodes (paginated). storage filter optional.
	// topLevelOnly drops the rows that were dragged into the trash with a folder
	// (their parent is trashed too), leaving one row per thing the user deleted.
	// The facets narrow inside the query rather than after it, so a filtered
	// page is a page of the filtered set and `total` counts that set.
	ListTrashed(ctx context.Context, storageID *int64, topLevelOnly bool, f NodeFacets, limit, offset int) ([]*model.Node, int, error)
	RestoreNode(ctx context.Context, id int64) error
	// RestoreNodeAt restores a soft-deleted node, simultaneously reverting its
	// path/path_hash to the supplied original-path values and re-attaching it
	// to the resolved parent_id (nil = root). Used by trash.Service.Restore
	// to undo the `.filex-trash/` rename.
	RestoreNodeAt(ctx context.Context, id int64, parentID *int64, origPath string) error
	// LookupParentByPath returns the parent_id (nil at root) for a path's
	// parent dir, or an error if the parent dir doesn't exist in the cache.
	LookupParentByPath(ctx context.Context, storageID int64, fullPath string) (*int64, error)

	// Per-user metadata (tags, starred, last_opened)
	SetUserNodeMeta(ctx context.Context, userID, nodeID int64, key, value string) error
	DeleteUserNodeMeta(ctx context.Context, userID, nodeID int64, key string) error
	GetUserNodeMeta(ctx context.Context, userID, nodeID int64, key string) (string, error)
	ListUserNodeMetaForNode(ctx context.Context, userID, nodeID int64, prefix string) (map[string]string, error)
	// The facets narrow inside the query: applying them to the page instead
	// would hand back the matches within the newest N rows and call that the
	// answer.
	ListNodesByUserMeta(ctx context.Context, userID int64, key string, f NodeFacets, limit int) ([]*model.Node, error)
	// UserNodeMetaTimes reports WHEN each of these nodes was flagged with
	// (key) for this user — the same user_node_meta.updated_at that
	// ListNodesByUserMeta orders by. No node row can carry it: "recently
	// opened" is a fact about the reader, not about the file. Without it a
	// client has only the file's own mtime to show and to sort by, which
	// undoes the server's order and dates "Today" by when the file was
	// written rather than read. Nodes with no such row are absent from the
	// answer rather than carried as a zero time.
	UserNodeMetaTimes(ctx context.Context, userID int64, key string, nodeIDs []int64) (map[int64]time.Time, error)

	// Tags use the shared node_meta table (key='tag:<name>', value='1').
	SetNodeTags(ctx context.Context, nodeID int64, tags []string) error
	GetNodeTags(ctx context.Context, nodeID int64) ([]string, error)
	ListAllTagsForStorage(ctx context.Context, storageID int64) ([]string, error)
	// ListAllTags returns every distinct tag across all storages (alphabetical).
	ListAllTags(ctx context.Context) ([]string, error)
	// ListNodesByTag returns non-deleted nodes carrying the given tag,
	// newest-first (by node updated_at), capped at limit.
	ListNodesByTag(ctx context.Context, tag string, limit int) ([]*model.Node, error)

	// Notifications (in-app bell + webhook delivery audit)
	InsertNotification(ctx context.Context, n *model.NotificationInput) (int64, error)
	GetNotification(ctx context.Context, id int64) (*model.Notification, error)
	ListNotifications(ctx context.Context, userID *int64, onlyUnread bool, limit, offset int) ([]*model.Notification, int64, error)
	// ListNodeEvents is the same table read the other way round: everything
	// recorded against ONE file, newest first — the per-node activity feed.
	ListNodeEvents(ctx context.Context, storageID int64, path string, limit int) ([]*model.Notification, error)
	MarkNotificationRead(ctx context.Context, id int64, userID *int64) error
	MarkAllNotificationsRead(ctx context.Context, userID *int64) error
	UnreadNotificationCount(ctx context.Context, userID *int64) (int64, error)
	UpdateWebhookStatus(ctx context.Context, id int64, status, errMsg string) error
	GetNotificationSettings(ctx context.Context, userID int64) (*model.NotificationSettings, error)
	UpsertNotificationSettings(ctx context.Context, s *model.NotificationSettings) error

	// Webhook targets (webhook v2, migration 00017) — additional POST
	// destinations next to the legacy single global webhook. Update
	// replaces the full mutable row (name/url/secret/events/enabled);
	// partial-PATCH merging happens in the handler.
	CreateWebhookTarget(ctx context.Context, t *model.WebhookTarget) (*model.WebhookTarget, error)
	GetWebhookTarget(ctx context.Context, id int64) (*model.WebhookTarget, error)
	ListWebhookTargets(ctx context.Context) ([]*model.WebhookTarget, error)
	UpdateWebhookTarget(ctx context.Context, t *model.WebhookTarget) error
	DeleteWebhookTarget(ctx context.Context, id int64) error
	// UpdateWebhookTargetDelivery records the outcome of the most recent
	// delivery attempt to one target (migration 00019): the final
	// attempt's HTTP status (0 = no response at all), the aggregated
	// error message ("" on success → stored NULL) and the attempt time.
	UpdateWebhookTargetDelivery(ctx context.Context, id int64, httpStatus int, errMsg string, at time.Time) error

	// Replica rules + failures + report + settings
	ListReplicaRules(ctx context.Context) ([]*model.ReplicaRule, error)
	GetReplicaRule(ctx context.Context, id int64) (*model.ReplicaRule, error)
	CreateReplicaRule(ctx context.Context, in *model.ReplicaRuleInput) (*model.ReplicaRule, error)
	UpdateReplicaRule(ctx context.Context, id int64, in *model.ReplicaRuleInput) (*model.ReplicaRule, error)
	DeleteReplicaRule(ctx context.Context, id int64) error

	UpsertReplicaFailure(ctx context.Context, path, op, errCode, errMsg string) error
	ResolveReplicaFailure(ctx context.Context, path, op string) error
	ListReplicaFailures(ctx context.Context, onlyUnresolved bool, limit, offset int) ([]*model.ReplicaFailure, int64, error)
	CountUnresolvedReplicaFailures(ctx context.Context) (int64, error)
	CountRecentlyResolvedReplicaFailures(ctx context.Context, since time.Time) (int64, error)

	UpsertReplicaStatusReport(ctx context.Context, total, failed, repaired int64, summaryJSON []byte) error
	GetReplicaStatusReport(ctx context.Context) (*model.ReplicaStatusReport, error)

	GetReplicaSettings(ctx context.Context) (*model.ReplicaSettings, error)
	UpsertReplicaSettings(ctx context.Context, s *model.ReplicaSettings) error

	/* calisma:d3 comments */
	// Node comments (migration 00020) — flat chronological threads on
	// file/folder nodes. List excludes soft-deleted rows and joins the
	// author display name; hard removal happens via the nodes FK CASCADE
	// plus DeleteNodeCommentsByNode in the trash purge hook.
	CreateNodeComment(ctx context.Context, c *model.NodeComment) (*model.NodeComment, error)
	GetNodeComment(ctx context.Context, id int64) (*model.NodeComment, error)
	ListNodeComments(ctx context.Context, nodeID int64) ([]*model.NodeComment, error)
	SoftDeleteNodeComment(ctx context.Context, id int64) error
	DeleteNodeCommentsByNode(ctx context.Context, nodeID int64) error

	// Providers (tenants). See docs/MULTI-TENANCY.md. Inert while multi-tenant
	// mode is off; a single "default" provider always exists (migration 00014).
	CreateProvider(ctx context.Context, p *model.Provider) (*model.Provider, error)
	GetProvider(ctx context.Context, id int64) (*model.Provider, error)
	GetProviderBySlug(ctx context.Context, slug string) (*model.Provider, error)
	// GetProviderByHost resolves a request Host to its tenant; returns nil if no
	// enabled provider claims that host.
	GetProviderByHost(ctx context.Context, host string) (*model.Provider, error)
	ListProviders(ctx context.Context) ([]*model.Provider, error)
	UpdateProvider(ctx context.Context, p *model.Provider) error
	DeleteProvider(ctx context.Context, id int64) error
	// GetSupertenant returns the single is_supertenant provider, or nil.
	GetSupertenant(ctx context.Context) (*model.Provider, error)

	// Provider ↔ storage links (M:N; 1:1 in the first UI).
	LinkProviderStorage(ctx context.Context, providerID, storageID int64) error
	UnlinkProviderStorage(ctx context.Context, providerID, storageID int64) error
	ListProviderStorageIDs(ctx context.Context, providerID int64) ([]int64, error)
	// GetProviderIDForStorage returns the (first) provider a storage is linked
	// to — used by background workers to derive tenancy from a storage.
	GetProviderIDForStorage(ctx context.Context, storageID int64) (int64, bool, error)

	/* kimlik:e3 cloud */
	// Provider plan metadata (cloud preparation, migration 00021 — see
	// docs/CLOUD.md). The columns are nullable and PASSIVE: only the
	// FILEX_CLOUD signup skeleton reads/writes them; with the flag off
	// (default) nothing touches these methods.
	SetProviderPlan(ctx context.Context, providerID int64, plan, limitsJSON, billingRef string) error
	GetProviderPlan(ctx context.Context, providerID int64) (plan, limitsJSON, billingRef string, err error)
}

// ExternalService is the DB row representation. Lives in the db package so
// model can stay pure-domain.
type ExternalService struct {
	Name        string
	Enabled     bool
	URL         string
	SecretEnc   string
	OptionsJSON string
	LastCheck   *time.Time
	LastState   string
}

// ShareWithMeta is the admin-list row that joins shares + creator email +
// node path + storage name so the admin UI doesn't have to issue N
// follow-up queries.
type ShareWithMeta struct {
	Share        *model.Share `json:"share"`
	CreatorEmail string       `json:"creator_email,omitempty"`
	NodePath     string       `json:"node_path,omitempty"`
	StorageName  string       `json:"storage_name,omitempty"`
}

// NodeFacets narrows a node set by the properties the advanced search filters
// on. A zero value matches every live node of the storage.
//
// Exts carries EXTENSIONS, not a type group: which extensions count as
// "documents" is the client's vocabulary, and a second copy of that taxonomy
// here is a second copy to keep in step. The client sends the list it means.
type NodeFacets struct {
	// PathPrefix confines the search to one subtree, given clean and slashed
	// ("/Docs"). Empty means the whole storage.
	PathPrefix string
	// Exts are lower-case and without the dot ("md", "pdf"). A node matches if
	// its name ends in any of them; empty means any extension.
	Exts          []string
	ModifiedAfter *time.Time
	SizeMin       *int64
	SizeMax       *int64
	OwnerID       *int64
	// FilesOnly drops directories. Type and size are properties of files, so a
	// filter on either is a filter for files; a date or an owner is not.
	FilesOnly bool
	// DirsOnly is its mirror, and exists for one caller: the destination picker,
	// which needs to find a folder anywhere on a drive without first walking the
	// whole drive to have something to filter. Setting both is a contradiction
	// and the caller that builds the facets refuses it rather than resolving it.
	DirsOnly bool
	// SharedOnly keeps only the nodes the caller has published a link to —
	// "shared" as SharedNodeIDs already means it for the badge on a listing
	// row: a share row exists and still opens. It is the advanced search's
	// "Search in → Shared files", which narrowed nothing at all before,
	// because the server had no word for it.
	SharedOnly bool
}

// Any reports whether the facets narrow anything at all.
func (f NodeFacets) Any() bool {
	return f.PathPrefix != "" || len(f.Exts) > 0 || f.ModifiedAfter != nil ||
		f.SizeMin != nil || f.SizeMax != nil || f.OwnerID != nil || f.FilesOnly ||
		f.DirsOnly || f.SharedOnly
}

// Where renders the facets as SQL predicates, to be ANDed into whatever the
// caller's own query already restricts. It lives here rather than in a driver
// because every listing that takes these facets has to mean the same thing by
// them: a second copy of "which column is the size" is a second copy to keep in
// step, and the two drivers differ only in how a placeholder is spelled.
//
// `bind` appends a value to the caller's argument list and returns the
// placeholder for it ("?" on sqlite, "$N" on postgres). It also owns how a
// time.Time reaches the engine: sqlite stores its date columns as TEXT and
// compares them as TEXT, so the driver renders the bound moment in the shape
// its own CURRENT_TIMESTAMP writes, while postgres binds the instant itself.
//
// `alias` qualifies the columns ("n." for a joined query, "" for a plain one).
// `modified` names the column the date window tests, because not every listing
// dates its rows the same way: the trash listing means "when it was deleted",
// every other listing means "when it was last written".
func (f NodeFacets) Where(alias, modified string, bind func(any) string) []string {
	var where []string
	if f.FilesOnly {
		where = append(where, alias+"type = "+bind(string(model.NodeTypeFile)))
	}
	if f.DirsOnly {
		where = append(where, alias+"type = "+bind(string(model.NodeTypeDirectory)))
	}
	if f.PathPrefix != "" && f.PathPrefix != "/" {
		// The subtree, and the folder itself.
		where = append(where, "("+alias+"path = "+bind(f.PathPrefix)+" OR "+alias+"path LIKE "+bind(likeEscape(f.PathPrefix)+"/%")+likeEscapeClause+")")
	}
	if len(f.Exts) > 0 {
		ors := make([]string, 0, len(f.Exts))
		for _, ext := range f.Exts {
			ors = append(ors, "LOWER("+alias+"name) LIKE "+bind("%."+likeEscape(ext))+likeEscapeClause)
		}
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	if f.ModifiedAfter != nil {
		where = append(where, alias+modified+" >= "+bind(*f.ModifiedAfter))
	}
	if f.SizeMin != nil {
		where = append(where, alias+"size >= "+bind(*f.SizeMin))
	}
	if f.SizeMax != nil {
		where = append(where, alias+"size <= "+bind(*f.SizeMax))
	}
	if f.OwnerID != nil {
		where = append(where, alias+"owner_id = "+bind(*f.OwnerID))
	}
	if f.SharedOnly {
		// The liveness test SharedNodeIDs applies, asked as a predicate so the
		// filter narrows inside the query instead of over the page the query
		// has already chosen. The moment is BOUND rather than spelled
		// (CURRENT_TIMESTAMP / NOW()): "still opens" is a statement about now,
		// and the drivers write and compare a Go time the same way here as
		// they do for every other expiry.
		// ⚠ The outer id is qualified even when nothing else here is. Inside the
		// subquery an unqualified `id` resolves to `shares` — which also has
		// one — so the correlation would silently read `sh.node_id = sh.id` and
		// match nothing. Every caller of these facets queries `nodes`.
		outer := alias
		if outer == "" {
			outer = "nodes."
		}
		where = append(where, "EXISTS (SELECT 1 FROM shares sh WHERE sh.node_id = "+outer+"id"+
			" AND (sh.expires_at IS NULL OR sh.expires_at > "+bind(time.Now().UTC())+")"+
			" AND (sh.max_downloads IS NULL OR sh.download_count < sh.max_downloads)"+
			" AND (sh.max_uploads IS NULL OR sh.upload_count < sh.max_uploads))")
	}
	return where
}

// likeEscapeChar is the character that turns off LIKE's two wildcards in the
// patterns built above.
//
// `!` rather than the usual backslash because the same SQL string is handed to
// three engines: MySQL reads a backslash inside a string literal, so `ESCAPE
// '\'` would have to be spelled differently there than on sqlite and postgres,
// and one spelling that means the same thing everywhere is worth more than
// following the convention.
const likeEscapeChar = "!"

// likeEscapeClause is appended to every LIKE built from a value that is meant
// to be read literally. sqlite has no default escape character at all, so it
// has to be named or the escaping below would be visible in the pattern.
const likeEscapeClause = ` ESCAPE '` + likeEscapeChar + `'`

var likeEscaper = strings.NewReplacer(
	likeEscapeChar, likeEscapeChar+likeEscapeChar,
	"%", likeEscapeChar+"%",
	"_", likeEscapeChar+"_",
)

// likeEscape neutralises the wildcards in a value that is to be matched
// literally. The values are BOUND, so this was never an injection — it was a
// wrong answer: `_` matches any single character, so a folder named `My_Docs`
// narrowed to `MyXDocs` as well, and an extension filter of `%` matched every
// file on the drive.
func likeEscape(s string) string { return likeEscaper.Replace(s) }

// NodeOwner is one node's owner, named. Nodes with no owner — anything a
// storage sync found rather than a person uploading it — are simply absent from
// the answer rather than carried as a null.
//
// Name is the account's display name and is empty when it has set none — never
// its e-mail address. See the note on NodeOwners.
type NodeOwner struct {
	NodeID  int64  `json:"node_id"`
	OwnerID int64  `json:"owner_id"`
	Name    string `json:"name"`
}

// AuditEntryWithUser is an audit row joined with the user.email column
// for nicer admin UI rendering.
type AuditEntryWithUser struct {
	Entry     *model.AuditEntry `json:"entry"`
	UserEmail string            `json:"user_email,omitempty"`
}

// DuplicateNode is one row of the duplicate-file report query — a slim
// projection of nodes (no timestamps/sync state) since the report only
// needs identity + grouping fields.
type DuplicateNode struct {
	ID        int64
	StorageID int64
	Path      string
	Name      string
	Size      int64
	Etag      string
}
