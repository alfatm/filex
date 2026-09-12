package sqlite_test

// The folder listing's own facets, and the unfiltered count it reports next to
// a filtered answer.

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
)

func TestListNodesByParentFiltered_AndCountStaysUnfiltered(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	old := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	recent := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	cut := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	stamp := func(at time.Time) func(*model.Node) { return func(n *model.Node) { n.BackendMtime = &at } }

	docs := mk("Docs", model.NodeTypeDirectory, stamp(recent))
	mk("a.md", model.NodeTypeFile, stamp(recent), func(n *model.Node) { n.Size = 10 })
	mk("b.txt", model.NodeTypeFile, stamp(old), func(n *model.Node) { n.Size = 5000 })
	gone := mk("gone.md", model.NodeTypeFile, stamp(recent))
	require.NoError(t, store.SoftDeleteNode(ctx, gone.ID))
	// A child of Docs, so the parent scope is proven and not just the storage.
	inner, err := store.CreateNode(ctx, &model.Node{
		StorageID: docs.StorageID, ParentID: &docs.ID, Name: "inner.md", Path: "/Docs/inner.md",
		PathHash: pathkey.Hash(docs.StorageID, "/Docs/inner.md"), Type: model.NodeTypeFile, BackendMtime: &recent,
	})
	require.NoError(t, err)

	md, err := store.ListNodesByParentFiltered(ctx, docs.StorageID, nil, db.NodeFacets{Exts: []string{"md"}, FilesOnly: true})
	require.NoError(t, err)
	assert.Equal(t, []string{"a.md"}, names(md), "live root files only: the trashed one and the nested one are out")

	since, err := store.ListNodesByParentFiltered(ctx, docs.StorageID, nil, db.NodeFacets{ModifiedAfter: &cut})
	require.NoError(t, err)
	assert.Equal(t, []string{"a.md", "Docs"}, names(since), "a date window keeps folders; the order is the listing's")

	under, err := store.ListNodesByParentFiltered(ctx, docs.StorageID, &docs.ID, db.NodeFacets{Exts: []string{"md"}, FilesOnly: true})
	require.NoError(t, err)
	assert.Equal(t, []string{inner.Name}, names(under))

	total, err := store.CountNodesByParent(ctx, docs.StorageID, nil)
	require.NoError(t, err)
	assert.Equal(t, 3, total, "live root children, unfiltered")
	total, err = store.CountNodesByParent(ctx, docs.StorageID, &docs.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
}

func TestNodeFacets_NameContainsIsLiteralAndCaseInsensitive(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	for _, name := range []string{"a_b.txt", "aXb.txt", "50%.txt", "500.txt", "REPORT.md"} {
		mk(name, model.NodeTypeFile)
	}
	sid := mk("z", model.NodeTypeDirectory).StorageID

	got, err := store.ListNodesByParentFiltered(ctx, sid, nil, db.NodeFacets{NameContains: "a_b"})
	require.NoError(t, err)
	assert.Equal(t, []string{"a_b.txt"}, names(got), "`_` in the needle is a literal underscore")

	got, err = store.ListNodesByParentFiltered(ctx, sid, nil, db.NodeFacets{NameContains: "%"})
	require.NoError(t, err)
	assert.Equal(t, []string{"50%.txt"}, names(got), "`%` in the needle is a literal percent sign")

	got, err = store.ListNodesByParentFiltered(ctx, sid, nil, db.NodeFacets{NameContains: "rep"})
	require.NoError(t, err)
	assert.Equal(t, []string{"REPORT.md"}, names(got))

	// The Go predicate has to agree with the SQL on every one of those.
	f := db.NodeFacets{NameContains: "a_b"}
	assert.True(t, f.Matches(&model.Node{Name: "a_b.txt", Type: model.NodeTypeFile}))
	assert.False(t, f.Matches(&model.Node{Name: "aXb.txt", Type: model.NodeTypeFile}))
	assert.True(t, db.NodeFacets{NameContains: "REP"}.Matches(&model.Node{Name: "report.md", Type: model.NodeTypeFile}))
}
