package sqlite_test

// The trash listing is flat: deleting a folder soft-deletes every row inside it
// too, and the user saw the folder AND each of its files as separate entries —
// "restore" on any of them being a lie, since only the folder's restore puts the
// subtree back. `topLevelOnly` is the server-side answer.
//
// "Top level" cannot mean "parent_id IS NULL": that is how the trash-aware
// delete marks the row it was given, but the sync poller also soft-deletes rows
// whose file vanished from the storage, and those keep their live parent. Such a
// row is nobody's child inside the trash and has to stay in the listing.

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestListTrashed_TopLevelOnlyDropsWhatAFolderDraggedIn(t *testing.T) {
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
	mk("rapor.txt", "/Docs/rapor.txt", model.NodeTypeFile, &docs.ID)
	live := mk("Live", "/Live", model.NodeTypeDirectory, nil)
	vanished := mk("gone.txt", "/Live/gone.txt", model.NodeTypeFile, &live.ID)

	// The user deletes the folder: the file inside comes along.
	const trashPath = "/.filex-trash/1__Docs"
	require.NoError(t, store.SoftDeleteAndRetag(ctx, docs.ID, trashPath, pathkey.Hash(stg.ID, trashPath), "/Docs"))
	// The sync poller finds a file missing from the storage and soft-deletes it
	// where it stands; its folder is still very much alive.
	require.NoError(t, store.SoftDeleteNode(ctx, vanished.ID))

	all, total, err := store.ListTrashed(ctx, &stg.ID, false, 100, 0)
	require.NoError(t, err)
	assert.Equal(t, 3, total)
	assert.Len(t, all, 3, "unfiltered, the file inside the deleted folder is a row of its own")

	top, topTotal, err := store.ListTrashed(ctx, &stg.ID, true, 100, 0)
	require.NoError(t, err)
	assert.Equal(t, 2, topTotal, "the total has to shrink too, or the page count lies")
	// storage_key, not name: a trashed row is renamed to its trash key, and the
	// original path is what the service shows and what Restore reads.
	origins := []string{}
	for _, n := range top {
		origins = append(origins, n.StorageKey)
	}
	assert.ElementsMatch(t, []string{"/Docs", "/Live/gone.txt"}, origins,
		"the deleted folder stays, the file it dragged in goes, and the vanished file — whose parent is alive — stays")
}
