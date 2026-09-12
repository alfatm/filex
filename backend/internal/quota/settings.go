// Package quota — settings.go
//
// The INSTANCE DEFAULTS behind the per-user overrides. They are dbsetting rows
// rather than config fields for the same reason every other admin-editable
// setting is: an operator raising the default file count must not have to
// restart the server, and the admin page has to be able to show what is
// actually in force.
//
// ⚠ The environment variables here SEED the rows on first boot and are inert
// afterwards — the dbsetting rule, spelled out in that package's doc comment.
//
// # The tri-state
//
// A user's `quota_bytes` / `quota_files` / `quota_upload_bytes` column is an
// OVERRIDE, not a value:
//
//	 0  inherit the default below
//	-1  unlimited for this user, whatever the default says
//	 N  this user's own limit
//
// Which is what lets migration 00042 ship without touching a single row: every
// existing user carries 0, every default starts at 0 = unlimited, and nothing
// that was allowed yesterday is refused today.
package quota

import (
	"context"
	"math"

	"github.com/brf-tech/filex/backend/internal/dbsetting"
)

// noCeiling is the Max on the three magnitudes: "as large as this build can
// express", i.e. effectively no upper bound.
//
// ⚠ It is math.MaxInt and NOT a literal like 1<<62, which is what it was until
// it broke the 32-bit build outright: dbsetting.IntSpec.Max is an `int`, so a
// 1<<62 constant does not fit one on a 32-bit target and `GOARCH=386 go build
// ./internal/quota/` failed to compile. math.MaxInt is an untyped constant that
// fits `int` on EVERY target by construction, and it costs nothing on the
// platforms we ship (amd64/arm64), where it is still ~9.2e18. Widening
// IntSpec.Max to int64 would be the other fix and a far larger one — Clamp,
// Validate, Resolve, parseSeed and every consumer of Resolve's `int` result.
const noCeiling = math.MaxInt

// The admin-editable defaults.
//
// ⚠ Min is 0 on the three magnitudes, which is unusual for an IntSpec: here 0
// is not "unset", it is the meaningful value "unlimited", and it is the
// default a fresh install must have so that turning quotas on is a deliberate
// act rather than something that happens by upgrading.
var (
	// DefaultBytesSetting is the storage ceiling a user with no byte override
	// gets. 0 = unlimited.
	DefaultBytesSetting = dbsetting.IntSpec{
		Key:     "quota.default_bytes",
		EnvVar:  "FILEX_QUOTA_DEFAULT_BYTES",
		Default: 0,
		Min:     0,
		Max:     noCeiling,
		Unit:    "bytes",
	}
	// DefaultFilesSetting is the file-COUNT ceiling. It exists because bytes
	// are not the only finite resource: a million empty files costs almost no
	// disk and still makes listings, scans and backups unusable.
	DefaultFilesSetting = dbsetting.IntSpec{
		Key:     "quota.default_files",
		EnvVar:  "FILEX_QUOTA_DEFAULT_FILES",
		Default: 0,
		Min:     0,
		Max:     noCeiling,
		Unit:    "files",
	}
	// DefaultUploadBytesSetting caps how many bytes one account may upload
	// within UploadWindowSetting. Unlike the storage ceiling this is not about
	// how much a person keeps — deleting yesterday's upload does not give the
	// allowance back, because the cost being limited is the transfer.
	DefaultUploadBytesSetting = dbsetting.IntSpec{
		Key:     "quota.default_upload_bytes",
		EnvVar:  "FILEX_QUOTA_DEFAULT_UPLOAD_BYTES",
		Default: 0,
		Min:     0,
		Max:     noCeiling,
		Unit:    "bytes per window",
	}
	// UploadWindowSetting is how far back the ledger is summed. One window for
	// the whole instance, not per user: the per-user knob is the allowance,
	// and two users on different window lengths would make "used this period"
	// mean two different things on one admin page.
	UploadWindowSetting = dbsetting.IntSpec{
		Key:     "quota.upload_window_hours",
		EnvVar:  "FILEX_QUOTA_UPLOAD_WINDOW_HOURS",
		Default: 24,
		Min:     1,
		Max:     720,
		Unit:    "hours",
	}
)

// Settings is the seed list, for one SeedAll call at boot.
func Settings() []dbsetting.Seeder {
	return []dbsetting.Seeder{
		DefaultBytesSetting, DefaultFilesSetting,
		DefaultUploadBytesSetting, UploadWindowSetting,
	}
}

// SeedSettings applies the first-boot seeding for every quota default.
func SeedSettings(ctx context.Context, st dbsetting.Store) {
	dbsetting.SeedAll(ctx, st, Settings()...)
}
