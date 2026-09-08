package handlers_test

// The owner column of a listing.
//
// filex has recorded an owner per node since migration 00004 — quota accounting
// writes it on every upload — but the listing projection never carried it, so
// the end-user app had no owner to show and filled the column with "You" for
// everything, on a shared drive included.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestNodeOwners_NamesTheAccountAndSkipsWhatNobodyOwns(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)

	ayse, err := store.CreateUser(ctx, "ayse@filex.test", "x", "user", "tr", "UTC")
	require.NoError(t, err)
	require.NoError(t, store.UpdateUserDisplayName(ctx, ayse.ID, "Ayşe"))
	// A second account with no display name at all: the e-mail is what the
	// listing has to show, not an empty cell.
	mert, err := store.CreateUser(ctx, "mert@filex.test", "x", "user", "tr", "UTC")
	require.NoError(t, err)

	mk := func(name string) *model.Node {
		clean := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: clean,
			PathHash: pathkey.Hash(st.ID, clean), Type: model.NodeTypeFile,
		})
		require.NoError(t, cerr)
		return n
	}
	hers, his, nobodys := mk("hers.txt"), mk("his.txt"), mk("found-by-sync.txt")
	require.NoError(t, store.SetNodeOwner(ctx, hers.ID, &ayse.ID))
	require.NoError(t, store.SetNodeOwner(ctx, his.ID, &mert.ID))

	owners, err := store.NodeOwners(ctx, []int64{hers.ID, his.ID, nobodys.ID})
	require.NoError(t, err)

	byNode := map[int64]db.NodeOwner{}
	for _, o := range owners {
		byNode[o.NodeID] = o
	}
	require.Len(t, byNode, 2, "a node nobody owns is absent, not owned by nobody")
	require.Equal(t, "Ayşe", byNode[hers.ID].Name)
	require.Equal(t, ayse.ID, byNode[hers.ID].OwnerID)
	require.Equal(t, "mert@filex.test", byNode[his.ID].Name, "no display name falls back to the e-mail")
	require.NotContains(t, byNode, nobodys.ID)

	// An empty ask is not an error and not a query.
	none, err := store.NodeOwners(ctx, nil)
	require.NoError(t, err)
	require.Empty(t, none)
}
