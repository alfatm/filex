package handlers_test

// A trash entry has to say whether it is a file or a folder.
//
// The listing projection carried a name, a size and a mime and nothing about
// the node's kind, even though the rows it is built from have one. The app has
// to draw the row from what it is given, so a deleted FOLDER came out wearing a
// file's icon — chosen by guessing at the extension of its name — with a byte
// count beside it where a folder shows a dash. Every other node the API returns
// answers this under `type`, and so does this one now.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/trash"
)

func TestTrashList_EntryCarriesTheNodeKind(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	admin, err := store.CreateUser(ctx, "yonetici@filex.test", "x", model.RoleAdmin, "en", "UTC")
	require.NoError(t, err)

	// A folder whose name looks like a file's is the case the app cannot guess
	// its way out of.
	for _, seed := range []struct {
		path string
		kind model.NodeType
	}{
		{"/Arsiv.2024", model.NodeTypeDirectory},
		{"/rapor.pdf", model.NodeTypeFile},
	} {
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: seed.path[1:], Path: seed.path,
			PathHash: pathkey.Hash(st.ID, seed.path), StorageKey: seed.path,
			Type: seed.kind, Size: 12,
		})
		require.NoError(t, cerr)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}

	h := handlers.NewTrash(trash.New(store, func(int64) (storage.Driver, error) { return nil, nil }, nil), store)
	h.AttachACL(acl.New(store))

	entries, _ := listTrash(t, h, admin, "limit=50")
	byName := map[string]map[string]any{}
	for _, e := range entries {
		byName[e["name"].(string)] = e
	}
	require.Len(t, byName, 2)
	assert.Equal(t, "dir", byName["Arsiv.2024"]["type"],
		"a deleted folder says so, rather than leaving the app to read its extension")
	assert.Equal(t, "file", byName["rapor.pdf"]["type"])
}
