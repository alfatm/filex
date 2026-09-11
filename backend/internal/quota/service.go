// Package quota tracks per-user storage usage and enforces the
// users.quota_bytes ceiling at upload time.
//
// quota_bytes == 0 means "unlimited". usage_bytes is incremented atomically
// in the DB on successful uploads and decremented on deletes; a periodic
// Recompute() job rebuilds it from authoritative node sizes.
package quota

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/brf-tech/filex/backend/internal/db"
)

// ErrQuotaExceeded is returned by CheckCanWrite when the user is out of room.
var ErrQuotaExceeded = errors.New("quota: exceeded")

// ErrUserNotFound means the id doesn't name a user.
//
// usage_bytes and quota_bytes are COALESCE'd columns on `users`, so a user
// that exists always reads back (0, 0) = "unlimited, nothing used". A
// no-rows result therefore says nothing about quotas — it says there is no
// such user, and the caller should answer 404 rather than leak
// `sql: no rows in result set` as a 500 (olivov H5, 2026-08-05).
var ErrUserNotFound = errors.New("quota: user not found")

// lookupUsage reads (used, limit) and normalises the missing-user case.
func (s *Service) lookupUsage(ctx context.Context, userID int64) (int64, int64, error) {
	used, limit, err := s.Store.GetUserUsage(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, ErrUserNotFound
	}
	return used, limit, err
}

// Service is the quota façade exposed to the rest of the codebase.
type Service struct {
	Store db.Store
}

// New constructs a Service.
func New(store db.Store) *Service { return &Service{Store: store} }

// Snapshot is the value returned by Get — used by the /quota/me handler and
// by the admin page. Every *_quota_* field is the EFFECTIVE value with the
// tri-state already resolved (0 == unlimited); Sources says whether that came
// from the user's own override or from the instance default.
type Snapshot struct {
	UsedBytes   int64   `json:"used_bytes"`
	QuotaBytes  int64   `json:"quota_bytes"` // 0 == unlimited
	PercentUsed float64 `json:"percent_used"`
	Unlimited   bool    `json:"unlimited"`

	UsedFiles      int64 `json:"used_files"`
	QuotaFiles     int64 `json:"quota_files"` // 0 == unlimited
	FilesUnlimited bool  `json:"files_unlimited"`

	UploadUsedBytes   int64 `json:"upload_used_bytes"` // inside the window
	UploadQuotaBytes  int64 `json:"upload_quota_bytes"`
	UploadWindowHours int   `json:"upload_window_hours"`
	UploadUnlimited   bool  `json:"upload_unlimited"`

	Sources SnapshotSources `json:"sources"`
}

// SnapshotSources says where each effective limit came from: "default" or
// "user". An admin looking at a number needs to know whether clearing the
// override would change it.
type SnapshotSources struct {
	Bytes  string `json:"bytes"`
	Files  string `json:"files"`
	Upload string `json:"upload"`
}

// CheckCanWrite refuses a write that would cross any of the three ceilings:
//
//	bytes        used_bytes + addBytes > Bytes          → ErrQuotaExceeded
//	files        usage_files + addFiles > Files         → ErrFileLimitExceeded
//	upload rate  window sum + addBytes > UploadBytes    → ErrUploadRateLimited
//
// A resolved limit of 0 is unlimited and passes; so does userID <= 0
// (anonymous / system). addBytes must already include whatever the caller has
// staged but not yet committed — see checkRate.
func (s *Service) CheckCanWrite(ctx context.Context, userID int64, addBytes, addFiles int64) error {
	if err := s.CheckCanStore(ctx, userID, addBytes, addFiles); err != nil {
		return err
	}
	if s == nil || s.Store == nil || userID <= 0 || addBytes <= 0 {
		return nil
	}
	lim, err := s.Limits(ctx, userID)
	if errors.Is(err, ErrUserNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.checkRate(ctx, userID, lim, addBytes)
}

// CheckCanStore is CheckCanWrite WITHOUT the upload-window check: the two
// STORAGE ceilings only.
//
// It exists for the surfaces whose write is not an "upload" in the sense the
// window is about, or that cannot express a 429 usefully: the WebDAV pre-gate
// and backstop (x/net/webdav turns a Close error into 405, so a rate refusal
// would reach the client as "stop using PUT"), and the S3/SFTP/FTP/NFS
// gateways, which are long-lived mounted sessions rather than a browser making
// requests. Their behaviour is therefore exactly what it was before the window
// existed.
//
// ⚠ The upload WINDOW is the only ceiling those surfaces are exempt from. Both
// STORAGE ceilings — bytes and the file COUNT — apply to every one of them, and
// addFiles is a real number at every call site: quotastore.AddFilesForWrite is
// how each of them computes it, from one node lookup and at most one driver
// stat, and only when a count ceiling is actually in force. It was 0 at every
// gateway until 2026-09-11, which made quota_files an HTTP-only limit while
// quotastore.CreateNode went on counting the rows those gateways wrote — a
// user refused 413 in the browser could push ten thousand files over SFTP and
// watch usage_files climb past the ceiling.
func (s *Service) CheckCanStore(ctx context.Context, userID int64, addBytes, addFiles int64) error {
	if s == nil || s.Store == nil {
		return nil
	}
	if userID <= 0 || (addBytes <= 0 && addFiles <= 0) {
		return nil
	}
	used, _, err := s.lookupUsage(ctx, userID)
	if errors.Is(err, ErrUserNotFound) {
		// Anonymous/system writes already pass above; an id with no user
		// row is not something to enforce a ceiling against.
		return nil
	}
	if err != nil {
		return fmt.Errorf("quota: read usage: %w", err)
	}
	lim, err := s.Limits(ctx, userID)
	if errors.Is(err, ErrUserNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if lim.Bytes > 0 && addBytes > 0 && used+addBytes > lim.Bytes {
		return ErrQuotaExceeded
	}
	if lim.Files > 0 && addFiles > 0 {
		usedFiles, ferr := s.Store.GetUserFileUsage(ctx, userID)
		if ferr != nil {
			return fmt.Errorf("quota: read file usage: %w", ferr)
		}
		if usedFiles+addFiles > lim.Files {
			return ErrFileLimitExceeded
		}
	}
	return nil
}

// AddUsage atomically grows usage_bytes by `bytes`.
func (s *Service) AddUsage(ctx context.Context, userID int64, bytes int64) error {
	if s == nil || s.Store == nil || userID <= 0 || bytes == 0 {
		return nil
	}
	return s.Store.IncrementUserUsage(ctx, userID, bytes)
}

// SubUsage atomically shrinks usage_bytes by `bytes`. The DB layer clamps
// the result at zero.
func (s *Service) SubUsage(ctx context.Context, userID int64, bytes int64) error {
	if s == nil || s.Store == nil || userID <= 0 || bytes == 0 {
		return nil
	}
	return s.Store.IncrementUserUsage(ctx, userID, -bytes)
}

// Recompute rebuilds usage_bytes from the SUM(size) of nodes owned by the user.
// Returns ErrUserNotFound for an id that isn't a user — the underlying UPDATE
// would otherwise touch no rows and report success.
func (s *Service) Recompute(ctx context.Context, userID int64) (int64, error) {
	if s == nil || s.Store == nil || userID <= 0 {
		return 0, nil
	}
	if _, _, err := s.lookupUsage(ctx, userID); err != nil {
		return 0, err
	}
	// The file count is rebuilt in the same pass: the two counters describe the
	// same node rows, and leaving one of them to a second endpoint is how they
	// come to disagree.
	if _, err := s.Store.RecomputeUserFileUsage(ctx, userID); err != nil {
		return 0, fmt.Errorf("quota: recompute files: %w", err)
	}
	return s.Store.RecomputeUserUsage(ctx, userID)
}

// SetQuota writes a new quota_bytes value (admin only — caller enforces).
// Returns ErrUserNotFound for an id that isn't a user, so an admin doesn't
// get a 200 for a write that landed nowhere.
func (s *Service) SetQuota(ctx context.Context, userID int64, bytes int64) error {
	if s == nil || s.Store == nil {
		return nil
	}
	if _, _, err := s.lookupUsage(ctx, userID); err != nil {
		return err
	}
	return s.Store.SetUserQuota(ctx, userID, bytes)
}

// Get returns the current snapshot. Returns ErrUserNotFound for an id that
// isn't a user.
func (s *Service) Get(ctx context.Context, userID int64) (Snapshot, error) {
	if s == nil || s.Store == nil {
		return Snapshot{Unlimited: true}, nil
	}
	used, _, err := s.lookupUsage(ctx, userID)
	if err != nil {
		return Snapshot{}, err
	}
	lim, err := s.Limits(ctx, userID)
	if err != nil {
		return Snapshot{}, err
	}
	usedFiles, err := s.Store.GetUserFileUsage(ctx, userID)
	if err != nil {
		return Snapshot{}, fmt.Errorf("quota: read file usage: %w", err)
	}
	uploadUsed, _, err := s.Store.SumUploadLedger(ctx, userID, time.Now().Add(-lim.UploadWindow))
	if err != nil {
		return Snapshot{}, fmt.Errorf("quota: read upload ledger: %w", err)
	}
	snap := Snapshot{
		UsedBytes:         used,
		QuotaBytes:        lim.Bytes,
		Unlimited:         lim.Bytes <= 0,
		UsedFiles:         usedFiles,
		QuotaFiles:        lim.Files,
		FilesUnlimited:    lim.Files <= 0,
		UploadUsedBytes:   uploadUsed,
		UploadQuotaBytes:  lim.UploadBytes,
		UploadWindowHours: int(lim.UploadWindow / time.Hour),
		UploadUnlimited:   lim.UploadBytes <= 0,
		Sources: SnapshotSources{
			Bytes:  lim.BytesSource,
			Files:  lim.FilesSource,
			Upload: lim.UploadSource,
		},
	}
	if used > 0 && lim.Bytes > 0 {
		snap.PercentUsed = (float64(used) / float64(lim.Bytes)) * 100.0
	}
	return snap, nil
}
