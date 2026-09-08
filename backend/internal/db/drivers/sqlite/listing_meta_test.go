package sqlite_test

// Two questions a listing page asks once for all of its rows: how many entries
// each folder holds, and which of these nodes a public link still opens. Both
// have to agree with what the listing itself shows — a count that includes the
// version bucket, or a "shared" badge on a link that expired yesterday, is worse
// than no answer at all.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestChildCountsMatchWhatTheListingShows(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	stg, err := store.CreateStorage(ctx, &model.Storage{
		Name: "s", Driver: "local", MountPath: "/", SyncMode: model.SyncModePoll, SyncIntervalS: 900, Enabled: true,
	})
	require.NoError(t, err)

	mk := func(name, p string, kind model.NodeType, parent *int64) *model.Node {
		n, err := store.CreateNode(ctx, &model.Node{
			StorageID: stg.ID, ParentID: parent, Name: name, Path: p,
			PathHash: pathkey.Hash(stg.ID, p), StorageKey: p, Type: kind,
		})
		require.NoError(t, err)
		return n
	}

	docs := mk("Docs", "/Docs", model.NodeTypeDirectory, nil)
	mk("a.txt", "/Docs/a.txt", model.NodeTypeFile, &docs.ID)
	mk("b.txt", "/Docs/b.txt", model.NodeTypeFile, &docs.ID)
	// Hidden from every listing projection, so it must be hidden from the count.
	mk(".versions", "/Docs/.versions", model.NodeTypeDirectory, &docs.ID)
	gone := mk("c.txt", "/Docs/c.txt", model.NodeTypeFile, &docs.ID)
	require.NoError(t, store.SoftDeleteNode(ctx, gone.ID))
	empty := mk("Empty", "/Empty", model.NodeTypeDirectory, nil)

	counts, err := store.ChildCounts(ctx, []int64{docs.ID, empty.ID})
	require.NoError(t, err)
	assert.Equal(t, int64(2), counts[docs.ID], "the trashed file and the version bucket are not entries the user can open")
	_, listed := counts[empty.ID]
	assert.False(t, listed, "a folder with no children is absent, so the handler can tell it apart from one it never asked about")
}

func TestSharedNodeIDsOnlyNamesLinksThatStillOpen(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	stg, err := store.CreateStorage(ctx, &model.Storage{
		Name: "s", Driver: "local", MountPath: "/", SyncMode: model.SyncModePoll, SyncIntervalS: 900, Enabled: true,
	})
	require.NoError(t, err)

	mk := func(name string) *model.Node {
		p := "/" + name
		n, err := store.CreateNode(ctx, &model.Node{
			StorageID: stg.ID, Name: name, Path: p,
			PathHash: pathkey.Hash(stg.ID, p), StorageKey: p, Type: model.NodeTypeFile,
		})
		require.NoError(t, err)
		return n
	}

	live, expired, exhausted, bare := mk("live.txt"), mk("expired.txt"), mk("exhausted.txt"), mk("bare.txt")
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	cap1 := 1

	_, err = store.CreateShare(ctx, &model.Share{NodeID: live.ID, Token: "t-live", ExpiresAt: &future})
	require.NoError(t, err)
	_, err = store.CreateShare(ctx, &model.Share{NodeID: expired.ID, Token: "t-exp", ExpiresAt: &past})
	require.NoError(t, err)
	full, err := store.CreateShare(ctx, &model.Share{NodeID: exhausted.ID, Token: "t-full", MaxDownloads: &cap1})
	require.NoError(t, err)
	require.NoError(t, store.IncrementShareDownload(ctx, full.ID))

	ids, err := store.SharedNodeIDs(ctx, []int64{live.ID, expired.ID, exhausted.ID, bare.ID})
	require.NoError(t, err)
	assert.Equal(t, []int64{live.ID}, ids)
}

func TestStorageUsageIsPerDriveAndCountsWhatTheDriveHolds(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	mkStorage := func(name string) *model.Storage {
		st, err := store.CreateStorage(ctx, &model.Storage{
			Name: name, Driver: "local", MountPath: "/", SyncMode: model.SyncModePoll, SyncIntervalS: 900, Enabled: true,
		})
		require.NoError(t, err)
		return st
	}
	main, archive := mkStorage("main"), mkStorage("archive")

	mk := func(st *model.Storage, name string, kind model.NodeType, size int64) *model.Node {
		p := "/" + name
		n, err := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p,
			PathHash: pathkey.Hash(st.ID, p), StorageKey: p, Type: kind, Size: size,
		})
		require.NoError(t, err)
		return n
	}
	mk(main, "a.bin", model.NodeTypeFile, 100)
	trashed := mk(main, "b.bin", model.NodeTypeFile, 50)
	// A directory row carries an aggregate of its subtree; counting it would double everything under it.
	mk(main, "Docs", model.NodeTypeDirectory, 999)
	mk(archive, "c.bin", model.NodeTypeFile, 7)
	require.NoError(t, store.SoftDeleteNode(ctx, trashed.ID))

	usage, err := store.StorageUsage(ctx, []int64{main.ID, archive.ID})
	require.NoError(t, err)
	assert.Equal(t, int64(150), usage[main.ID], "a file in the trash still sits on the driver, so it still counts")
	assert.Equal(t, int64(7), usage[archive.ID], "each drive answers for itself")
}
