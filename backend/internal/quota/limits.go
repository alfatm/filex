// Package quota — limits.go
//
// The resolution of the three per-user OVERRIDES against the three instance
// DEFAULTS, and the two ceilings that came with them: a file COUNT and an
// upload RATE.
//
// # Resolution, once, here
//
//	override == -1  →  unlimited for this user  (resolved value 0)
//	override >   0  →  this user's own limit    (source "user")
//	override ==  0  →  the instance default     (source "default")
//
// The resolved struct then speaks ONE language: 0 means unlimited, anything
// else is a ceiling. Nothing downstream re-reads a tri-state, which is the
// point — "is -1 unlimited or is it a bug" is a question that gets answered in
// exactly one function.
//
// # Why the rate limit is a ledger and not a counter
//
// A counter on `users` would have to be reset by something, and whatever did
// the resetting would decide the window for everyone at once — a user who
// uploaded at 23:59 would get a fresh allowance one minute later. A row per
// completed upload makes the window SLIDING and, more importantly, makes
// Retry-After answerable: the moment the oldest row inside the window falls
// out is the moment the allowance grows again.
package quota

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/brf-tech/filex/backend/internal/dbsetting"
)

// The two ceilings added in migration 00042, alongside ErrQuotaExceeded.
var (
	// ErrFileLimitExceeded is returned when the file COUNT ceiling is reached.
	ErrFileLimitExceeded = errors.New("quota: file limit exceeded")
)

// ErrUploadRateLimited is returned when the upload window is full. It carries
// RetryAfter because a 429 with no such hint leaves a client to guess, and the
// honest answer is known exactly: the moment the oldest row in the window ages
// out of it.
type ErrUploadRateLimited struct {
	RetryAfter time.Duration
}

func (e ErrUploadRateLimited) Error() string {
	return fmt.Sprintf("quota: upload limit reached, retry in %s", e.RetryAfter)
}

// Limit sources, reported so an admin page can say WHY a number is what it is.
const (
	SourceDefault = "default"
	SourceUser    = "user"
)

// Limits is the resolved set of ceilings in force for one user. In every one
// of the three magnitudes, 0 means unlimited — the tri-state has already been
// resolved away.
type Limits struct {
	Bytes        int64
	Files        int64
	UploadBytes  int64
	UploadWindow time.Duration
	BytesSource  string
	FilesSource  string
	UploadSource string
}

// resolveOne applies the tri-state rule to one column.
func resolveOne(override int64, def int64) (int64, string) {
	switch {
	case override < 0:
		return 0, SourceUser // explicitly unlimited for this user
	case override > 0:
		return override, SourceUser
	default:
		return def, SourceDefault
	}
}

// Limits returns the ceilings in force for userID.
//
// The defaults are read at the point of USE, per dbsetting's rule, so an
// operator raising the instance default affects the next upload rather than
// the next restart.
func (s *Service) Limits(ctx context.Context, userID int64) (Limits, error) {
	window := time.Duration(UploadWindowSetting.Resolve(ctx, s.settings())) * time.Hour
	lim := Limits{
		UploadWindow: window,
		BytesSource:  SourceDefault,
		FilesSource:  SourceDefault,
		UploadSource: SourceDefault,
	}
	if s == nil || s.Store == nil {
		return lim, nil
	}
	defBytes := int64(DefaultBytesSetting.Resolve(ctx, s.settings()))
	defFiles := int64(DefaultFilesSetting.Resolve(ctx, s.settings()))
	defUpload := int64(DefaultUploadBytesSetting.Resolve(ctx, s.settings()))
	lim.Bytes, lim.Files, lim.UploadBytes = defBytes, defFiles, defUpload
	if userID <= 0 {
		return lim, nil
	}
	oBytes, oFiles, oUpload, err := s.Store.GetUserLimits(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return lim, ErrUserNotFound
	}
	if err != nil {
		return lim, fmt.Errorf("quota: read limits: %w", err)
	}
	lim.Bytes, lim.BytesSource = resolveOne(oBytes, defBytes)
	lim.Files, lim.FilesSource = resolveOne(oFiles, defFiles)
	lim.UploadBytes, lim.UploadSource = resolveOne(oUpload, defUpload)
	return lim, nil
}

// settings adapts the store to dbsetting's reader. A nil service or store
// resolves every setting to its Default rather than panicking, because every
// surface that holds a *Service is allowed to hold a nil one.
func (s *Service) settings() dbsetting.Getter {
	if s == nil || s.Store == nil {
		return nil
	}
	return s.Store
}

// Overrides returns the three RAW tri-state columns, for the admin page that
// edits them. Everything that enforces a limit wants Limits instead.
func (s *Service) Overrides(ctx context.Context, userID int64) (bytes, files, upload int64, err error) {
	if s == nil || s.Store == nil || userID <= 0 {
		return 0, 0, 0, nil
	}
	bytes, files, upload, err = s.Store.GetUserLimits(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, 0, ErrUserNotFound
	}
	return bytes, files, upload, err
}

// SetOverrides writes whichever of the three overrides the caller named.
// Values are the tri-state: -1, 0 or a positive limit. The caller (the admin
// handler) rejects anything below -1 before this is reached.
func (s *Service) SetOverrides(ctx context.Context, userID int64, bytes, files, upload *int64) error {
	if s == nil || s.Store == nil {
		return nil
	}
	if _, _, err := s.lookupUsage(ctx, userID); err != nil {
		return err
	}
	return s.Store.SetUserLimits(ctx, userID, bytes, files, upload)
}

// AddUsageFiles adjusts usage_files by delta (the DB clamps at 0).
func (s *Service) AddUsageFiles(ctx context.Context, userID int64, delta int64) error {
	if s == nil || s.Store == nil || userID <= 0 || delta == 0 {
		return nil
	}
	return s.Store.IncrementUserFileUsage(ctx, userID, delta)
}

// RecordUpload appends one row to the upload ledger. Called ONLY on the
// success path of a completed upload: an upload that was refused, aborted or
// failed cost the instance nothing to keep and must not spend the allowance.
//
// For a write that can be RETRIED against the same stored object, use
// RecordStagedUpload instead — this one charges every call.
func (s *Service) RecordUpload(ctx context.Context, userID int64, bytes int64) error {
	if s == nil || s.Store == nil || userID <= 0 || bytes <= 0 {
		return nil
	}
	return s.Store.InsertUploadLedger(ctx, userID, bytes, "")
}

// RecordStagedUpload is RecordUpload keyed by a staged-upload id, so the
// allowance is spent AT MOST ONCE for that upload however many times the
// commit path runs.
//
// It exists because a staged commit is retryable on purpose: a transfer that
// fails leaves the staging directory in place and the row in `failed`, which
// ClaimStagedUploadCommit accepts, and the whole commit sequence — publish the
// node, submit the op, record the upload — runs again. Three failed transfers
// of a 1 GB file used to spend 4 GB for one stored gigabyte.
//
// ⚠ The key, and not "record only on a claim that came from `staging`": the
// insert itself can fail (it is logged, never fatal, because the bytes are
// already safe), and a first attempt that lost its ledger row would then never
// be charged at all. Keyed, the retry inserts the row the first attempt
// missed, and a retry after a successful insert is the no-op.
func (s *Service) RecordStagedUpload(ctx context.Context, userID int64, bytes int64, uploadID string) error {
	if s == nil || s.Store == nil || userID <= 0 || bytes <= 0 {
		return nil
	}
	return s.Store.InsertUploadLedger(ctx, userID, bytes, uploadID)
}

// UploadWindowUsed returns (bytes uploaded inside the window, the window).
func (s *Service) UploadWindowUsed(ctx context.Context, userID int64) (int64, time.Duration, error) {
	window := time.Duration(UploadWindowSetting.Resolve(ctx, s.settings())) * time.Hour
	if s == nil || s.Store == nil || userID <= 0 {
		return 0, window, nil
	}
	used, _, err := s.Store.SumUploadLedger(ctx, userID, time.Now().Add(-window))
	return used, window, err
}

// SweepUploadLedger drops ledger rows older than `before`. The sweeper keeps
// at least one whole window, because a row inside the window is still holding
// part of somebody's allowance.
func (s *Service) SweepUploadLedger(ctx context.Context, before time.Time) (int64, error) {
	if s == nil || s.Store == nil {
		return 0, nil
	}
	return s.Store.SweepUploadLedger(ctx, before)
}

// minRetryAfter is the floor on a Retry-After. Zero (or a negative, from a
// clock that moved) would invite an immediate retry that is refused again.
const minRetryAfter = time.Second

// checkRate enforces the upload window.
//
// Bytes that are staged but not yet committed are NOT looked up here: only the
// caller knows which of its own sessions are open, so it folds
// SumOpenStagedUploadBytes into addBytes (see the staged begin) exactly as it
// already does for the byte ceiling.
//
// ⚠ What that sum must NOT include is a `committing` row: the ledger row is
// written at commit, so those bytes are already inside `used` below and adding
// them again refused a user who was under the limit — with a full-window
// Retry-After, the worst possible answer to a request that should have passed.
func (s *Service) checkRate(ctx context.Context, userID int64, lim Limits, addBytes int64) error {
	if lim.UploadBytes <= 0 {
		return nil // unlimited
	}
	now := time.Now()
	used, oldest, err := s.Store.SumUploadLedger(ctx, userID, now.Add(-lim.UploadWindow))
	if err != nil {
		return fmt.Errorf("quota: read upload ledger: %w", err)
	}
	if used+addBytes <= lim.UploadBytes {
		return nil
	}
	// The allowance next grows when the oldest row inside the window leaves
	// it. With no rows at all the request is simply bigger than the whole
	// window allows and no amount of waiting helps — a full window is still
	// the most honest thing to say, and the client is told the limit itself
	// in the body.
	retry := lim.UploadWindow
	if !oldest.IsZero() {
		retry = oldest.Add(lim.UploadWindow).Sub(now)
	}
	if retry < minRetryAfter {
		retry = minRetryAfter
	}
	return ErrUploadRateLimited{RetryAfter: retry}
}
