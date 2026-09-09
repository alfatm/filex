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

// The modified window compares two dates that are not written by the same
// party: the lower bound arrives from a handler in UTC, while backend_mtime is
// whatever zone the storage driver handed back (local, sftp and smb all report
// the host's). modernc writes a time.Time with its offset and SQLite compares
// those as TEXT, so before the dates were normalised the offset shifted the
// string: east of UTC an hour-old file passed a thirty-minute window, west of
// it a ten-minute-old file failed one.
//
// TestListNodesByUserMeta_ModifiedWindowReadsTheWriteDate above does not catch
// this — both of its sides are in the same zone.
func TestModifiedWindowIgnoresTheZoneTheMtimeWasWrittenIn(t *testing.T) {
	ctx, store, user, mk := facetFixture(t)
	east := time.FixedZone("+03", 3*60*60)
	west := time.FixedZone("-05", -5*60*60)

	stale := mk("eski.md", model.NodeTypeFile, func(n *model.Node) {
		at := time.Now().Add(-time.Hour).In(east)
		n.BackendMtime = &at
	})
	recent := mk("yeni.md", model.NodeTypeFile, func(n *model.Node) {
		at := time.Now().Add(-10 * time.Minute).In(west)
		n.BackendMtime = &at
	})
	for _, n := range []*model.Node{stale, recent} {
		require.NoError(t, store.SetUserNodeMeta(ctx, user, n.ID, "opened", "1"))
	}

	cutoff := time.Now().Add(-30 * time.Minute).UTC()
	window, err := store.ListNodesByUserMeta(ctx, user, "opened", db.NodeFacets{ModifiedAfter: &cutoff}, 50)
	require.NoError(t, err)
	assert.Equal(t, []string{"yeni.md"}, names(window),
		"the window is thirty minutes wide whatever zone the mtimes were recorded in")

	ids, err := store.ListNodeIDsMatching(ctx, recent.StorageID, db.NodeFacets{ModifiedAfter: &cutoff}, 50)
	require.NoError(t, err)
	assert.Equal(t, []int64{recent.ID}, ids, "the search facet reads the same dates as the listing")
}

// Deleting a folder stamps ONE deleted_at across every row under it, and
// SQLite's CURRENT_TIMESTAMP is written to the second — so the whole block is
// indistinguishable by the only key the trash listing ordered on. LIMIT/OFFSET
// over an ambiguous order is free to hand the same row out twice and never hand
// out another, which is what paging through a bulk delete did.
//
// The assertion is on the order itself rather than on a flake: with the
// tie-break the pages read newest id first and every row appears exactly once.
func TestListTrashed_PagingIsStableWhenOneDeleteSharesAStamp(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	made := []string{"a.md", "b.md", "c.md", "d.md", "e.md", "f.md"}
	for _, name := range made {
		n := mk(name, model.NodeTypeFile)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}

	var paged []string
	for offset := 0; offset < len(made); offset += 2 {
		rows, total, err := store.ListTrashed(ctx, nil, false, db.NodeFacets{}, 2, offset)
		require.NoError(t, err)
		require.Equal(t, len(made), total)
		require.Len(t, rows, 2, "page at offset %d", offset)
		paged = append(paged, names(rows)...)
	}
	assert.Equal(t, []string{"f.md", "e.md", "d.md", "c.md", "b.md", "a.md"}, paged,
		"one stamp for six rows, so the id is what decides — newest first, each row once")
}

// The facet patterns are LIKE patterns built from what the caller typed. The
// values are bound, so there was never an injection here — there was a wrong
// answer: `%` means "anything", so an extension chip of `%` matched every file
// on the drive.
func TestFacetPatternsAreMatchedLiterally(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	for _, name := range []string{"a.md", "kupa.png"} {
		n := mk(name, model.NodeTypeFile)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}

	rows, total, err := store.ListTrashed(ctx, nil, false, db.NodeFacets{Exts: []string{"%"}, FilesOnly: true}, 50, 0)
	require.NoError(t, err)
	assert.Empty(t, names(rows), "no file is called `.%%`, so the filter answers nothing")
	assert.Zero(t, total)

	// And a real extension still narrows, which is what makes the above mean
	// something rather than "escaping broke LIKE".
	rows, total, err = store.ListTrashed(ctx, nil, false, db.NodeFacets{Exts: []string{"png"}, FilesOnly: true}, 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"kupa.png"}, names(rows))
	assert.Equal(t, 1, total)
}

// The same for the path prefix, where `_` is LIKE's single-character wildcard:
// confining a search to `My_Docs` also reached into `MyXDocs`, a folder the
// person was not asking about and may not even have meant to be reminded of.
func TestPathPrefixUnderscoreIsNotAWildcard(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	mine := mk("My_Docs/rapor.md", model.NodeTypeFile)
	other := mk("MyXDocs/rapor.md", model.NodeTypeFile)

	ids, err := store.ListNodeIDsMatching(ctx, mine.StorageID, db.NodeFacets{PathPrefix: "/My_Docs"}, 50)
	require.NoError(t, err)
	assert.Equal(t, []int64{mine.ID}, ids)
	assert.NotContains(t, ids, other.ID, "an underscore in a folder name is a character, not a wildcard")
}

// `deleted_at` is written by SQLite's own CURRENT_TIMESTAMP — UTC, to the
// second, no zone on the end — while the window's lower bound arrives as a
// time.Time the driver renders in Go's layout, offset and all. SQLite compares
// the two as TEXT, so east of UTC the bound string reads as a later date than
// every row deleted a moment ago and the trash answers "nothing".
//
// TestListTrashed_ModifiedWindowReadsTheDeletionDate above does not catch this:
// its window is a week wide, so the day component still separates the two
// strings whatever the offset does to the hour. A window of minutes — "deleted
// today", the one the trash chip actually asks for — has nothing left to lean
// on.
func TestListTrashed_NarrowModifiedWindowIgnoresTheCutoffZone(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	n := mk("eski.md", model.NodeTypeFile)
	require.NoError(t, store.SoftDeleteNode(ctx, n.ID))

	// A fixed zone rather than the host's, so the test means the same thing
	// wherever it runs: +09 pushes the rendered date a day forward for most of
	// the UTC day, which is exactly what the text comparison then reads.
	cutoff := time.Now().Add(-5 * time.Minute).In(time.FixedZone("+09", 9*60*60))
	rows, total, err := store.ListTrashed(ctx, nil, false, db.NodeFacets{ModifiedAfter: &cutoff}, 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"eski.md"}, names(rows),
		"deleted seconds ago, so a five-minute window holds it whatever zone the cutoff was expressed in")
	assert.Equal(t, 1, total, "and the total counts the same set the page came from")

	// The mirror: a window that closed before the deletion still excludes it,
	// or the fix above would just be "the filter stopped filtering".
	future := time.Now().Add(5 * time.Minute).In(time.FixedZone("-07", -7*60*60))
	rows, total, err = store.ListTrashed(ctx, nil, false, db.NodeFacets{ModifiedAfter: &future}, 50, 0)
	require.NoError(t, err)
	assert.Empty(t, names(rows))
	assert.Zero(t, total)
}
