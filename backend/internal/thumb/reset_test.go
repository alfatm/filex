package thumb_test

// Pipeline.Reset — the admin-triggered "drop these thumbnails and build them
// again" (the two buttons on the Storages page).
//
// Unlike the sweeper next door, this one deletes thumbnails of files that are
// alive, so the properties worth measuring are the scope (one storage must not
// take another's cache with it) and the ORDER: the row has to be gone
// afterwards, because "ready" is the one state a backfill never re-runs. A
// reset that removed the JPEG and left the row would leave the grid with a
// permanently missing thumbnail, which is worse than the placeholder it was
// meant to replace.

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
)

// thumbed gives a node a cached thumbnail: a "ready" row and the JPEG on disk.
func thumbed(t *testing.T, store db.Store, dir string, n *model.Node) string {
	t.Helper()
	path := aged(t, dir, strconv.FormatInt(n.ID, 10)+".jpg", 80)
	require.NoError(t, store.UpsertThumbnail(context.Background(), &model.Thumbnail{
		NodeID:     n.ID,
		State:      "ready",
		StorageKey: path,
	}))
	return path
}

// secondStorage adds another drive to a reapFixture install.
func secondStorage(t *testing.T, store db.Store) int64 {
	t.Helper()
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name: "s2", Driver: "local", MountPath: "s2", Enabled: true,
		ConfigJSON: []byte(`{}`),
	})
	require.NoError(t, err)
	return st.ID
}

// The per-drive button: one storage's thumbnails go, the other drive is
// untouched — rows AND files.
func TestReset_IsScopedToOneStorage(t *testing.T) {
	ctx := context.Background()
	store, p, dir, sid := reapFixture(t)
	other := secondStorage(t, store)

	mine := newNode(t, store, sid, "mine.pdf")
	theirs := newNode(t, store, other, "theirs.pdf")
	minePath := thumbed(t, store, dir, mine)
	theirsPath := thumbed(t, store, dir, theirs)

	cleared, err := p.Reset(ctx, sid)
	require.NoError(t, err)
	require.Equal(t, 1, cleared)

	require.NoFileExists(t, minePath)
	require.FileExists(t, theirsPath)

	// Absent rows come back as an error, the way Forget's test reads them.
	_, err = store.GetThumbnail(ctx, mine.ID)
	require.Error(t, err, "the row must be gone: a backfill never re-runs state=ready")

	kept, err := store.GetThumbnail(ctx, theirs.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", kept.State)
}

// The header button: every drive at once.
func TestReset_AllStoragesClearsEverything(t *testing.T) {
	ctx := context.Background()
	store, p, dir, sid := reapFixture(t)
	other := secondStorage(t, store)

	a := newNode(t, store, sid, "a.mp4")
	b := newNode(t, store, other, "b.mp4")
	aPath := thumbed(t, store, dir, a)
	bPath := thumbed(t, store, dir, b)

	cleared, err := p.Reset(ctx, 0)
	require.NoError(t, err)
	require.Equal(t, 2, cleared)

	require.NoFileExists(t, aPath)
	require.NoFileExists(t, bPath)
	for _, id := range []int64{a.ID, b.ID} {
		_, err := store.GetThumbnail(ctx, id)
		require.Error(t, err)
	}
}

// Nothing cached: a plain zero, not an error — it is what the admin UI reports
// as "there was nothing to clear". And the cache directory is not swept while
// we are there: only the ids whose rows this call removed are touched.
func TestReset_WithNothingCachedClearsNothingElse(t *testing.T) {
	store, p, dir, sid := reapFixture(t)
	newNode(t, store, sid, "no-thumb.png")
	stranger := aged(t, dir, "999999.jpg", 40)

	cleared, err := p.Reset(context.Background(), sid)
	require.NoError(t, err)
	require.Equal(t, 0, cleared)
	require.FileExists(t, stranger)
}

// A row whose JPEG is already gone (the demo stack's cache directory is not a
// volume, so it evaporates on every container recreate) still resets cleanly —
// this is exactly the state that needs repairing most.
func TestReset_SurvivesAMissingCacheFile(t *testing.T) {
	ctx := context.Background()
	store, p, dir, sid := reapFixture(t)

	n := newNode(t, store, sid, "orphan-row.pdf")
	path := thumbed(t, store, dir, n)
	require.NoError(t, os.Remove(path))

	cleared, err := p.Reset(ctx, sid)
	require.NoError(t, err)
	require.Equal(t, 1, cleared)
	require.NoFileExists(t, filepath.Join(dir, strconv.FormatInt(n.ID, 10)+".jpg"))

	_, err = store.GetThumbnail(ctx, n.ID)
	require.Error(t, err)
}
