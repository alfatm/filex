package handlers

// Two things a listing row could not previously say about itself: how many
// entries a folder holds, and whether a public link to it is open. Both are
// answered for the whole page at once — and the count is deliberately withheld
// where RBAC could make it overstate what opening the folder would show.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/db"
	_ "github.com/brf-tech/filex/backend/internal/db/drivers/sqlite"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
)

// newStore is testutil.NewTestDB, inlined: these tests exercise unexported
// helpers, so they live IN package handlers — and testutil reaches the store
// through internal/api, which imports this package. Importing it here would be
// a cycle.
func newStore(t *testing.T) db.Store {
	t.Helper()
	drv := db.MustGet("sqlite")
	conn, err := drv.Open(context.Background(), fmt.Sprintf("file:filex_listing_meta_%s?mode=memory&cache=shared", t.Name()))
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	require.NoError(t, db.Migrate(context.Background(), drv, conn))
	return drv.NewStore(conn)
}

func TestAttachItemCounts_CountsForAdminsAndStaysSilentUnderRBAC(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)

	mk := func(name, p string, kind model.NodeType, parent *int64) *model.Node {
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, ParentID: parent, Name: name, Path: p,
			PathHash: pathkey.Hash(st.ID, p), Type: kind,
		})
		require.NoError(t, cerr)
		return n
	}
	docs := mk("Docs", "/Docs", model.NodeTypeDirectory, nil)
	mk("public.txt", "/Docs/public.txt", model.NodeTypeFile, &docs.ID)
	mk("secret.txt", "/Docs/secret.txt", model.NodeTypeFile, &docs.ID)
	empty := mk("Empty", "/Empty", model.NodeTypeDirectory, nil)
	loose := mk("loose.txt", "/loose.txt", model.NodeTypeFile, nil)

	admin, err := store.CreateUser(ctx, "admin@filex.test", "x", model.RoleAdmin, "en", "UTC")
	require.NoError(t, err)
	resolver := acl.New(store)
	adminSet, err := resolver.LoadSet(ctx, admin, st)
	require.NoError(t, err)

	page := []*model.Node{docs, empty, loose}
	attachItemCounts(ctx, store, page, adminSet)
	require.NotNil(t, docs.ItemCount)
	require.Equal(t, int64(2), *docs.ItemCount)
	require.NotNil(t, empty.ItemCount, "an empty folder was counted, and its count is zero")
	require.Equal(t, int64(0), *empty.ItemCount)
	require.Nil(t, loose.ItemCount, "a file has no entries to count")

	// A grant holder sees a subset of the same folder, and one grouped query
	// cannot subtract what they may not see — so nothing is claimed.
	docs.ItemCount, empty.ItemCount = nil, nil
	viewer, err := store.CreateUser(ctx, "viewer@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	_, err = store.CreateFileGrant(ctx, &model.FileGrant{StorageID: st.ID, UserID: viewer.ID, PathPrefix: "Docs/public.txt", Level: "viewer"})
	require.NoError(t, err)
	viewerSet, err := resolver.LoadSet(ctx, viewer, st)
	require.NoError(t, err)

	attachItemCounts(ctx, store, page, viewerSet)
	require.Nil(t, docs.ItemCount, "a traversal folder must not advertise entries the caller cannot open")
	require.Nil(t, empty.ItemCount)
}

func TestAttachShared_FlagsOnlyTheRowsWithALiveLink(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)

	mk := func(name string) *model.Node {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p,
			PathHash: pathkey.Hash(st.ID, p), Type: model.NodeTypeFile,
		})
		require.NoError(t, cerr)
		return n
	}
	linked, plain := mk("linked.txt"), mk("plain.txt")
	share, err := store.CreateShare(ctx, &model.Share{NodeID: linked.ID, Token: "tok-listing"})
	require.NoError(t, err)

	page := []*model.Node{linked, plain}
	attachShared(ctx, store, page)
	require.True(t, linked.Shared)
	require.False(t, plain.Shared)

	// Revoking the link has to take the badge away on the next listing.
	require.NoError(t, store.RevokeShare(ctx, share.ID))
	linked.Shared = false
	attachShared(ctx, store, page)
	require.False(t, linked.Shared, "a revoked link is not a share the listing should advertise")
}
