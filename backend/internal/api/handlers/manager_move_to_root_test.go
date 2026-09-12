package handlers_test

// Moving something INTO A STORAGE ROOT. The bytes always arrived; the DB row is
// what broke, and it broke silently — the queued op reported "ok", the folder
// disappeared from every listing, and the trash grew a row whose bytes were
// never in `.filex-trash`, so Restore could not put it back either.
//
// The cause was one strip too many: `path.Dir("Alpha")` is ".", a directory in
// no index, and the miss fell into the soft-delete branch meant for a row whose
// parent the sync has yet to catch up with. Both callers of applyDBMove — the
// synchronous `?q=move` and the ops worker's SyncMove — shared it.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestManager_SyncMove_ToStorageRoot_KeepsTheRowAlive(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	root := t.TempDir()

	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(root) + `"}`),
	})
	require.NoError(t, err)

	mk := func(clean string, kind model.NodeType, parent *int64) *model.Node {
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, ParentID: parent, Name: baseName(clean),
			Path: clean, PathHash: pathkey.Hash(st.ID, clean), Type: kind,
		})
		require.NoError(t, cerr)
		return n
	}
	docs := mk("/Docs", model.NodeTypeDirectory, nil)
	moved := mk("/Docs/Alpha", model.NodeTypeDirectory, &docs.ID)

	mgr := handlers.NewManager(store, func(int64) (storage.Driver, error) { return drv, nil })
	mgr.SyncMove(ctx, st.ID, "Docs/Alpha", "Alpha")

	got, err := store.GetNode(ctx, moved.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Nil(t, got.DeletedAt, "a move to the root is not a deletion")
	require.Equal(t, "/Alpha", got.Path)
	require.Nil(t, got.ParentID, "the storage root is the absence of a parent, not a directory row")

	// And the row answers to its new address, which is what every listing looks it up by.
	at, err := store.GetNodeByPath(ctx, st.ID, pathkey.Hash(st.ID, "/Alpha"))
	require.NoError(t, err)
	require.NotNil(t, at)
	require.Equal(t, moved.ID, at.ID)
}

func TestManager_SyncMove_IntoAFolder_StillFindsItsParent(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	root := t.TempDir()

	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(root) + `"}`),
	})
	require.NoError(t, err)

	docs, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "Docs", Path: "/Docs",
		PathHash: pathkey.Hash(st.ID, "/Docs"), Type: model.NodeTypeDirectory,
	})
	require.NoError(t, err)
	loose, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "Alpha", Path: "/Alpha",
		PathHash: pathkey.Hash(st.ID, "/Alpha"), Type: model.NodeTypeDirectory,
	})
	require.NoError(t, err)

	mgr := handlers.NewManager(store, func(int64) (storage.Driver, error) { return drv, nil })
	mgr.SyncMove(ctx, st.ID, "Alpha", "Docs/Alpha")

	got, err := store.GetNode(ctx, loose.ID)
	require.NoError(t, err)
	require.Nil(t, got.DeletedAt)
	require.Equal(t, "/Docs/Alpha", got.Path)
	require.NotNil(t, got.ParentID)
	require.Equal(t, docs.ID, *got.ParentID)
}

func baseName(clean string) string {
	for i := len(clean) - 1; i >= 0; i-- {
		if clean[i] == '/' {
			return clean[i+1:]
		}
	}
	return clean
}
