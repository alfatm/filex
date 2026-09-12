// Package quotastore — addfiles.go
//
// The ONE answer to "does this write claim a new file slot", shared by every
// write surface in the tree.
//
// # Why it had to move out of internal/api/handlers
//
// quota.Service.CheckCanStore takes an addFiles count, and until this file
// existed exactly one caller computed a real one: the /dav pre-gate. Every
// other gateway passed 0 — internal/s3api (write, copy, multipart complete),
// internal/sftpsrv, internal/ftpsrv, internal/nfssrv and the /dav Close
// backstop — so the file-COUNT ceiling was enforced on HTTP and on nothing
// else. With quota_files = 10 and a user at 10, every browser upload was
// refused 413 FILE_LIMIT_EXCEEDED while `sftp put` of ten thousand files
// succeeded and usage_files climbed to 10 010, because quotastore.CreateNode
// counts the rows regardless of who let them in.
//
// The gateways could not reach the handlers' targetHasFile (that would invert
// the dependency), and a copy each is how the /dav one came to disagree with
// the HTTP one in the first place: it asked the node cache alone, so a file
// present on the backend but never scanned read as NEW and was refused on a
// full count. So the logic lives here — next to the counter it feeds, which is
// the one package that cannot be bypassed by a new write path.
package quotastore

import (
	"context"
	"errors"
	"log/slog"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/protocolsync"
	"github.com/brf-tech/filex/backend/internal/quota"
	"github.com/brf-tech/filex/backend/internal/storage"
)

// TargetHasFile reports whether a file already occupies rel on storageID.
//
// The node row is asked FIRST — it is what listings show, and it covers a
// `staged` file whose bytes have not reached the driver yet. The driver is
// asked only when the catalogue has nothing, because a file written outside
// filex (or found by a scan that has not run yet) is still a file the user is
// replacing rather than adding.
//
// ⚠ An inconclusive driver answer — Stat failing with anything other than
// ErrNotFound — degrades to "no file", which is what the HTTP surfaces already
// do (handlers.ensureNameFree logs and allows). That direction is the safe one
// for a COUNT: it can over-count the write by one slot and refuse somebody at
// their exact limit, never let a write past a full ceiling.
func TargetHasFile(ctx context.Context, store db.Store, drv storage.Driver, storageID int64, rel string) bool {
	if store != nil {
		clean := protocolsync.NormalizePath(rel)
		if n, err := store.GetNodeByPath(ctx, storageID, pathkey.Hash(storageID, clean)); err == nil &&
			n != nil && n.Type == model.NodeTypeFile {
			return true
		}
	}
	if drv == nil || rel == "" {
		return false
	}
	if _, err := drv.Stat(ctx, rel); err != nil {
		if !errors.Is(err, storage.ErrNotFound) {
			slog.Debug("quota: file-count target check inconclusive, counting as new",
				slog.Int64("storage", storageID),
				slog.String("path", rel),
				slog.String("err", err.Error()))
		}
		return false
	}
	// ⚠ ANY object counts, a directory included — exactly what
	// handlers.ensureNameFree reports, so the HTTP surfaces that delegate here
	// keep the behaviour they had to the letter. A directory sitting at the key
	// is storage.ErrKindConflict and the write is refused by
	// storage.EnsureFileTarget before a slot could be spent either way, so the
	// count this returns for that case is never the deciding answer.
	return true
}

// AddFilesForWrite is the addFiles argument for a write landing at rel: 1 when
// it creates a file, 0 when it replaces one.
//
// An OVERWRITE claims no slot — the file is already this account's — so a user
// at their file ceiling can still replace a file they own, which is the one
// thing they must always be able to do.
//
// ⚠ The lookups are paid for ONLY when the count ceiling is actually in force
// for this user. On an object store the driver Stat is a network round trip,
// and on an instance with no file limit (the default) it would buy nothing:
// CheckCanStore ignores addFiles when the resolved limit is unlimited. An
// unreadable limit is treated as "in force" and the write counted as new — the
// over-refusing direction, same as everywhere else here.
func AddFilesForWrite(ctx context.Context, q *quota.Service, store db.Store, drv storage.Driver,
	userID, storageID int64, rel string) int64 {
	if q == nil || userID <= 0 {
		return 1
	}
	if lim, err := q.Limits(ctx, userID); err == nil && lim.Files <= 0 {
		return 1 // no count ceiling: the value is never read, so buy nothing
	}
	if TargetHasFile(ctx, store, drv, storageID, rel) {
		return 0
	}
	return 1
}
