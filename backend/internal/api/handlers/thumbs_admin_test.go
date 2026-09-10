package handlers_test

// The admin thumbnail-reset endpoints, through the real router so the
// admin gate and the route shapes are exercised together:
//
//	POST /api/admin/storages/{id}/thumbs/reset
//	POST /api/admin/thumbs/reset
//
// What each test is actually protecting:
//   - the row is GONE afterwards (state="ready" is never re-run by a backfill,
//     so a reset that only removed the JPEG would break the grid for good);
//   - the scope (one drive's reset must not clear another's);
//   - the response tells the truth about whether the server is rebuilding the
//     thumbnails itself, because when it is not, the admin has to run
//     `filex thumb backfill` by hand.

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// thumbResetFixture wires a real pipeline over a temp cache dir and records
// what the reset endpoints ask to regenerate. backfill=false leaves
// Deps.ThumbBackfill nil, which is how a server with no backfill wired
// behaves.
func thumbResetFixture(t *testing.T, backfill bool) (*http.Client, db.Store, string, *[][]int64, string) {
	t.Helper()
	dir := t.TempDir()
	calls := &[][]int64{}

	srv, client, store := testutil.NewTestServerWith(t, nil, func(d *api.Deps) {
		d.Thumbs = thumb.New(d.Store, dir, thumb.Capabilities{Image: true})
		if backfill {
			d.ThumbBackfill = func(ids []int64) { *calls = append(*calls, ids) }
		}
	})

	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)
	return client, store, dir, calls, srv.URL
}

// cachedThumb creates a storage, a file node on it, and the node's cached
// thumbnail (a "ready" row plus the JPEG on disk).
func cachedThumb(t *testing.T, store db.Store, dir, storageName, fileName string) (int64, int64, string) {
	t.Helper()
	ctx := t.Context()
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: storageName, Driver: "local", MountPath: storageName, Enabled: true,
		ConfigJSON: []byte(`{}`),
	})
	require.NoError(t, err)
	n, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID,
		Name:      fileName,
		Path:      "/" + fileName,
		PathHash:  pathkey.Hash(st.ID, "/"+fileName),
		Type:      model.NodeTypeFile,
		Size:      10,
	})
	require.NoError(t, err)

	path := filepath.Join(dir, strconv.FormatInt(n.ID, 10)+".jpg")
	require.NoError(t, os.WriteFile(path, []byte("jpeg"), 0o644))
	require.NoError(t, store.UpsertThumbnail(ctx, &model.Thumbnail{
		NodeID: n.ID, State: "ready", StorageKey: path,
	}))
	return st.ID, n.ID, path
}

func TestThumbsReset_OneStorageClearsItAndStartsRegeneration(t *testing.T) {
	client, store, dir, calls, url := thumbResetFixture(t, true)
	sid, nid, path := cachedThumb(t, store, dir, "mine", "clip.mp4")
	_, otherNode, otherPath := cachedThumb(t, store, dir, "other", "doc.pdf")

	resp, err := client.Post(url+"/api/admin/storages/"+strconv.FormatInt(sid, 10)+"/thumbs/reset", "", nil)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusAccepted, resp.StatusCode)

	var got map[string]any
	testutil.ReadJSON(t, resp, &got)
	assert.EqualValues(t, 1, got["cleared"])
	assert.Equal(t, true, got["regenerating"])

	require.NoFileExists(t, path)
	_, err = store.GetThumbnail(t.Context(), nid)
	require.Error(t, err, "the row must be gone, or a backfill will skip it as state=ready")

	// The other drive is untouched, and the regeneration was asked for by id.
	require.FileExists(t, otherPath)
	_, err = store.GetThumbnail(t.Context(), otherNode)
	require.NoError(t, err)
	require.Equal(t, [][]int64{{sid}}, *calls)
}

func TestThumbsReset_AllStoragesClearsEveryDrive(t *testing.T) {
	client, store, dir, calls, url := thumbResetFixture(t, true)
	_, _, aPath := cachedThumb(t, store, dir, "a", "a.mp4")
	_, _, bPath := cachedThumb(t, store, dir, "b", "b.pdf")

	resp, err := client.Post(url+"/api/admin/thumbs/reset", "", nil)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusAccepted, resp.StatusCode)

	var got map[string]any
	testutil.ReadJSON(t, resp, &got)
	assert.EqualValues(t, 2, got["cleared"])

	require.NoFileExists(t, aPath)
	require.NoFileExists(t, bPath)
	// nil ids = every enabled storage, which is what BackfillThumbs takes.
	require.Equal(t, [][]int64{nil}, *calls)
}

// With no backfill wired the reset still happens — and says so, rather than
// promising a regeneration that is not coming.
func TestThumbsReset_WithoutBackfillReportsNoRegeneration(t *testing.T) {
	client, store, dir, calls, url := thumbResetFixture(t, false)
	sid, _, path := cachedThumb(t, store, dir, "mine", "clip.mp4")

	resp, err := client.Post(url+"/api/admin/storages/"+strconv.FormatInt(sid, 10)+"/thumbs/reset", "", nil)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusAccepted, resp.StatusCode)

	var got map[string]any
	testutil.ReadJSON(t, resp, &got)
	assert.EqualValues(t, 1, got["cleared"])
	assert.Equal(t, false, got["regenerating"])
	require.NoFileExists(t, path)
	require.Empty(t, *calls)
}

func TestThumbsReset_WithThumbnailsDisabledIs503(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t) // no Thumbs in Deps
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)

	resp, err := client.Post(srv.URL+"/api/admin/thumbs/reset", "", nil)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
}

// The gate: these endpoints drop other people's thumbnails, so they belong to
// admins only.
func TestThumbsReset_IsAdminOnly(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)

	resp, err := client.Post(srv.URL+"/api/admin/thumbs/reset", "", nil)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, "anonymous → 401")

	testutil.SeedRegularUser(t, store, "joe@test.local", "JoeUserPass1!")
	testutil.LoginAs(t, srv, client, "joe@test.local", "JoeUserPass1!")
	resp2, err := client.Post(srv.URL+"/api/admin/thumbs/reset", "", nil)
	require.NoError(t, err)
	resp2.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp2.StatusCode, "non-admin → 403")
}
