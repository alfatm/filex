package quotastore_test

// The FILE-COUNT half of the decorator (migration 00042), pinned the same way
// the byte half is: against a real sqlite store, checking that
// `users.usage_files` actually moves.
//
//	usage_files(u) == COUNT(*) WHERE owner_id=u AND type='file'

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/quotastore"
)

func (e *env) files(t *testing.T, userID int64) int64 {
	t.Helper()
	n, err := e.raw.GetUserFileUsage(context.Background(), userID)
	require.NoError(t, err)
	return n
}

func TestFileCount_CreateCountsOneFileAndNoFolder(t *testing.T) {
	e := newEnv(t)
	ctx := asUser(e.alice)

	e.file(t, ctx, "a.bin", 10)
	e.file(t, ctx, "b.bin", 20)
	assert.EqualValues(t, 2, e.files(t, e.alice))

	_, err := e.store.CreateNode(ctx, &model.Node{
		StorageID: e.storageID, Name: "d", Path: "/d", PathHash: "d",
		Type: model.NodeTypeDirectory, Size: 4096,
	})
	require.NoError(t, err)
	assert.EqualValues(t, 2, e.files(t, e.alice), "a folder is not a file")
}

func TestFileCount_NoActingUserCountsNothing(t *testing.T) {
	e := newEnv(t)
	e.file(t, context.Background(), "found.bin", 5000)
	assert.EqualValues(t, 0, e.files(t, e.alice))
	assert.EqualValues(t, 0, e.files(t, e.bob))
}

// An overwrite by the SAME owner is one file before and one file after.
func TestFileCount_OverwriteBySameOwnerDoesNotDouble(t *testing.T) {
	e := newEnv(t)
	ctx := asUser(e.alice)
	n := e.file(t, ctx, "a.bin", 1000)

	require.NoError(t, e.store.UpdateNodeMeta(ctx, n.ID, 2000, "", "", time.Now()))
	assert.EqualValues(t, 1, e.files(t, e.alice))
	assert.EqualValues(t, 2000, e.usage(t, e.alice))
}

// Re-attribution moves the COUNT with the bytes: the file is bob's now.
func TestFileCount_OverwriteByAnotherUserMovesTheCount(t *testing.T) {
	e := newEnv(t)
	n := e.file(t, asUser(e.alice), "a.bin", 1000)

	require.NoError(t, e.store.UpdateNodeMeta(asUser(e.bob), n.ID, 1500, "", "", time.Now()))
	assert.EqualValues(t, 0, e.files(t, e.alice))
	assert.EqualValues(t, 1, e.files(t, e.bob))
}

// A node the scanner found was counted by nobody, so adoption takes nothing
// away from anybody.
func TestFileCount_OverwriteAdoptsAnUnownedNode(t *testing.T) {
	e := newEnv(t)
	n := e.file(t, context.Background(), "found.bin", 500)
	require.EqualValues(t, 0, e.files(t, e.alice))

	require.NoError(t, e.store.UpdateNodeMeta(asUser(e.alice), n.ID, 700, "", "", time.Now()))
	assert.EqualValues(t, 1, e.files(t, e.alice))
}

// Trash keeps counting; the purge is the only release point — the same rule
// the byte counter follows, for the same reason.
func TestFileCount_TrashKeepsCountingAndPurgeReleases(t *testing.T) {
	e := newEnv(t)
	ctx := asUser(e.alice)
	n := e.file(t, ctx, "a.bin", 1000)

	require.NoError(t, e.store.SoftDeleteNode(ctx, n.ID))
	assert.EqualValues(t, 1, e.files(t, e.alice), "a trashed file still occupies a slot")

	require.NoError(t, e.store.HardDeleteNode(ctx, n.ID))
	assert.EqualValues(t, 0, e.files(t, e.alice))
}

// The reconciler has to agree with the incremental accounting, trashed rows
// included — otherwise a recompute silently forgives slots that the purge will
// then release a second time.
func TestFileCount_RecomputeAgreesWithTheIncrementalTotal(t *testing.T) {
	e := newEnv(t)
	ctx := quotastore.WithOwner(context.Background(), e.alice)
	e.file(t, ctx, "a.bin", 10)
	n := e.file(t, ctx, "b.bin", 20)
	require.NoError(t, e.store.SoftDeleteNode(ctx, n.ID))
	require.EqualValues(t, 2, e.files(t, e.alice))

	total, err := e.raw.RecomputeUserFileUsage(context.Background(), e.alice)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)
	assert.EqualValues(t, 2, e.files(t, e.alice))
}
