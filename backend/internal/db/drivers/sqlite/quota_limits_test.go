package sqlite_test

// The store half of migration 00042: the upload ledger (sum / oldest / sweep)
// and the usage_files counter.
//
// Timestamps are compared the way ListIdleStagedUploads does — CURRENT_TIMESTAMP
// is `YYYY-MM-DD HH:MM:SS` text, so a backdated row is written with
// datetime('now', …) rather than with a bound time.Time, and the bound the
// store sends is formatted the same way. Getting that wrong is invisible until
// a test runs in a timezone east of UTC, which is why these run under
// TZ=Asia/Istanbul.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestStore_UploadLedger_SumOldestAndSweep(t *testing.T) {
	sqlDB, store := testutil.NewTestDB(t)
	ctx := context.Background()

	alice, err := store.CreateUser(ctx, "alice@test.local", "x", "user", "en", "UTC")
	require.NoError(t, err)
	bob, err := store.CreateUser(ctx, "bob@test.local", "x", "user", "en", "UTC")
	require.NoError(t, err)

	sum, oldest, err := store.SumUploadLedger(ctx, alice.ID, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.Zero(t, sum)
	assert.True(t, oldest.IsZero(), "no rows → no oldest")

	require.NoError(t, store.InsertUploadLedger(ctx, alice.ID, 100, ""))
	require.NoError(t, store.InsertUploadLedger(ctx, alice.ID, 250, ""))
	require.NoError(t, store.InsertUploadLedger(ctx, bob.ID, 999, ""))

	sum, oldest, err = store.SumUploadLedger(ctx, alice.ID, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.EqualValues(t, 350, sum, "another user's uploads are not alice's")
	assert.False(t, oldest.IsZero())
	assert.WithinDuration(t, time.Now(), oldest, 2*time.Minute)

	// Age the 100-byte row out of a 30-minute window; the 250 stays.
	_, err = sqlDB.Exec(`UPDATE upload_ledger SET created_at=datetime('now','-90 minutes') WHERE bytes=100`)
	require.NoError(t, err)

	sum, oldest, err = store.SumUploadLedger(ctx, alice.ID, time.Now().Add(-30*time.Minute))
	require.NoError(t, err)
	assert.EqualValues(t, 250, sum, "a row outside the window holds no allowance")
	assert.WithinDuration(t, time.Now(), oldest, 2*time.Minute, "the oldest INSIDE the window")

	// The sweeper drops what has fallen out of every window.
	n, err := store.SweepUploadLedger(ctx, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.EqualValues(t, 1, n)

	sum, _, err = store.SumUploadLedger(ctx, alice.ID, time.Now().Add(-24*time.Hour))
	require.NoError(t, err)
	assert.EqualValues(t, 250, sum, "the swept row is gone for good")
}

func TestStore_UsageFilesAndLimits(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()

	u, err := store.CreateUser(ctx, "counter@test.local", "x", "user", "en", "UTC")
	require.NoError(t, err)

	// Fresh account: every override is 0 = inherit the instance default.
	b, f, up, err := store.GetUserLimits(ctx, u.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 0, b)
	assert.EqualValues(t, 0, f)
	assert.EqualValues(t, 0, up)

	// -1 is legal and is NOT clamped to zero the way SetUserQuota clamps.
	unlimited := int64(-1)
	files := int64(10)
	require.NoError(t, store.SetUserLimits(ctx, u.ID, &unlimited, &files, nil))
	b, f, up, err = store.GetUserLimits(ctx, u.ID)
	require.NoError(t, err)
	assert.EqualValues(t, -1, b)
	assert.EqualValues(t, 10, f)
	assert.EqualValues(t, 0, up, "a column the caller did not name is untouched")

	// The counter, and its clamp at zero.
	require.NoError(t, store.IncrementUserFileUsage(ctx, u.ID, 3))
	got, err := store.GetUserFileUsage(ctx, u.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 3, got)
	require.NoError(t, store.IncrementUserFileUsage(ctx, u.ID, -9))
	got, err = store.GetUserFileUsage(ctx, u.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 0, got, "clamped, never negative")

	// Recompute rebuilds it from the node rows — trashed rows included.
	st, err := store.CreateStorage(ctx, &model.Storage{Name: "main", Driver: "local", MountPath: "/", Enabled: true})
	require.NoError(t, err)
	for _, name := range []string{"a.txt", "b.txt"} {
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: "/" + name, PathHash: name,
			StorageKey: "/" + name, Type: model.NodeTypeFile, Size: 1,
		})
		require.NoError(t, cerr)
		require.NoError(t, store.SetNodeOwner(ctx, n.ID, &u.ID))
	}
	total, err := store.RecomputeUserFileUsage(ctx, u.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)
	got, err = store.GetUserFileUsage(ctx, u.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 2, got)
}

func TestStore_SearchUsers_PagesAndFilters(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()

	for _, email := range []string{"ann@a.local", "bob@b.local", "carol@c.local"} {
		_, err := store.CreateUser(ctx, email, "x", "user", "en", "UTC")
		require.NoError(t, err)
	}

	all, total, err := store.SearchUsers(ctx, "", nil, 50, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total)
	assert.Len(t, all, 3)

	page, total, err := store.SearchUsers(ctx, "", nil, 2, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total, "total is the count BEFORE paging")
	assert.Len(t, page, 2)

	page, _, err = store.SearchUsers(ctx, "", nil, 2, 2)
	require.NoError(t, err)
	assert.Len(t, page, 1)

	// q is a case-insensitive substring on the e-mail (or display name).
	found, total, err := store.SearchUsers(ctx, "BOB", nil, 50, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, found, 1)
	assert.Equal(t, "bob@b.local", found[0].Email)
}
