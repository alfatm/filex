package sqlite_test

// The flat listings — starred, recently opened, trash — are capped. Whether the
// filter chips are applied inside the query or to the page it returns is the
// whole difference between "there are no images among your starred files" and
// "there are none among the newest N of them", and the second answer looks
// exactly like the first.
//
// So each test here starves the listing of room on purpose: it asks for a page
// smaller than the unfiltered set, and checks that what comes back is a page of
// the FILTERED set.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// facetFixture builds one storage and a maker for nodes in it.
func facetFixture(t *testing.T) (context.Context, db.Store, int64, func(name string, kind model.NodeType, opts ...func(*model.Node)) *model.Node) {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "sahip@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	stg, err := store.CreateStorage(ctx, &model.Storage{
		Name: "s", Driver: "local", MountPath: "/", SyncMode: model.SyncModePoll, SyncIntervalS: 900, Enabled: true,
	})
	require.NoError(t, err)
	mk := func(name string, kind model.NodeType, opts ...func(*model.Node)) *model.Node {
		n := &model.Node{
			StorageID: stg.ID, Name: name, Path: "/" + name,
			PathHash: pathkey.Hash(stg.ID, "/"+name), StorageKey: "/" + name, Type: kind,
		}
		for _, o := range opts {
			o(n)
		}
		created, err := store.CreateNode(ctx, n)
		require.NoError(t, err)
		return created
	}
	return ctx, store, user.ID, mk
}

func names(nodes []*model.Node) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.Name)
	}
	return out
}

func TestListNodesByUserMeta_FacetsNarrowTheSetNotThePage(t *testing.T) {
	ctx, store, user, mk := facetFixture(t)

	// Starred newest-first: three notes, then the one image. A limit of two
	// would show the notes and nothing else if the filter came after the page.
	for _, name := range []string{"kupa.png", "c.md", "b.md", "a.md"} {
		n := mk(name, model.NodeTypeFile)
		require.NoError(t, store.SetUserNodeMeta(ctx, user, n.ID, "starred", "1"))
		time.Sleep(2 * time.Millisecond) // the listing orders by meta updated_at
	}

	unfiltered, err := store.ListNodesByUserMeta(ctx, user, "starred", db.NodeFacets{}, 2)
	require.NoError(t, err)
	assert.Equal(t, []string{"a.md", "b.md"}, names(unfiltered), "newest first, and the image is out of reach")

	images, err := store.ListNodesByUserMeta(ctx, user, "starred", db.NodeFacets{Exts: []string{"png"}, FilesOnly: true}, 2)
	require.NoError(t, err)
	assert.Equal(t, []string{"kupa.png"}, names(images),
		"the image is the oldest starred row: reachable only if the filter is part of the query")
}

func TestListNodesByUserMeta_SizeAndOwner(t *testing.T) {
	ctx, store, user, mk := facetFixture(t)
	stranger, err := store.CreateUser(ctx, "baskasi@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	other := stranger.ID

	big := mk("big.md", model.NodeTypeFile, func(n *model.Node) { n.Size = 5 << 20 })
	small := mk("small.md", model.NodeTypeFile, func(n *model.Node) { n.Size = 10 })
	// Ownership is its own write: CreateNode does not carry it.
	require.NoError(t, store.SetNodeOwner(ctx, big.ID, &user))
	require.NoError(t, store.SetNodeOwner(ctx, small.ID, &other))
	for _, n := range []*model.Node{big, small} {
		require.NoError(t, store.SetUserNodeMeta(ctx, user, n.ID, "starred", "1"))
	}

	min := int64(1 << 20)
	bySize, err := store.ListNodesByUserMeta(ctx, user, "starred", db.NodeFacets{SizeMin: &min, FilesOnly: true}, 50)
	require.NoError(t, err)
	assert.Equal(t, []string{"big.md"}, names(bySize))

	byOwner, err := store.ListNodesByUserMeta(ctx, user, "starred", db.NodeFacets{OwnerID: &other}, 50)
	require.NoError(t, err)
	assert.Equal(t, []string{"small.md"}, names(byOwner))
}

func TestListNodesByUserMeta_ModifiedWindowReadsTheWriteDate(t *testing.T) {
	ctx, store, user, mk := facetFixture(t)
	old := time.Now().Add(-90 * 24 * time.Hour)
	fresh := time.Now().Add(-time.Hour)

	for _, tc := range []struct {
		name string
		at   time.Time
	}{{"eski.md", old}, {"yeni.md", fresh}} {
		n := mk(tc.name, model.NodeTypeFile, func(n *model.Node) { at := tc.at; n.BackendMtime = &at })
		require.NoError(t, store.SetUserNodeMeta(ctx, user, n.ID, "opened", "1"))
	}

	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	week, err := store.ListNodesByUserMeta(ctx, user, "opened", db.NodeFacets{ModifiedAfter: &cutoff}, 50)
	require.NoError(t, err)
	assert.Equal(t, []string{"yeni.md"}, names(week))
}

func TestListTrashed_FacetsNarrowTheSetAndTheTotal(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)

	for _, name := range []string{"a.md", "b.md", "kupa.png"} {
		n := mk(name, model.NodeTypeFile)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}

	rows, total, err := store.ListTrashed(ctx, nil, false, db.NodeFacets{Exts: []string{"png"}, FilesOnly: true}, 2, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"kupa.png"}, names(rows))
	assert.Equal(t, 1, total, "the total counts the filtered set, or the page count lies")
}

func TestListTrashed_ModifiedWindowReadsTheDeletionDate(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)

	// A file written long ago and deleted a moment ago belongs in the trash's
	// "last 7 days" — that column shows when it was deleted, not when it was
	// last written, and the window has to test the same date the column shows.
	long := time.Now().Add(-90 * 24 * time.Hour)
	n := mk("eski.md", model.NodeTypeFile, func(n *model.Node) { n.BackendMtime = &long })
	require.NoError(t, store.SoftDeleteNode(ctx, n.ID))

	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	rows, _, err := store.ListTrashed(ctx, nil, false, db.NodeFacets{ModifiedAfter: &cutoff}, 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"eski.md"}, names(rows),
		"deleted today, so it is in the window however old the file itself is")
}
