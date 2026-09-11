package handlers_test

// GET /api/files/thumb/{id} and the browser cache.
//
// The bug these measure: the endpoint answered `private, max-age=86400` under
// a URL that carries the node id and nothing else. A regenerated thumbnail was
// therefore invisible for a DAY — reset the cache from the admin UI, or add
// ffmpeg and backfill, and the grid kept painting the old picture, which reads
// as "the reset did not work" rather than "your browser is holding a copy".
//
// The contract now: revalidate every time, and let the ETag turn the usual case
// into a bodiless 304.

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// getThumb fetches one thumbnail, optionally conditionally.
func getThumb(t *testing.T, client *http.Client, url string, id int64, ifNoneMatch string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url+"/api/files/thumb/"+strconv.FormatInt(id, 10), nil)
	require.NoError(t, err)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := client.Do(req)
	require.NoError(t, err)
	return resp
}

func TestThumbServe_RevalidatesAndAnswers304ForAnUnchangedThumbnail(t *testing.T) {
	client, store, dir, _, url := thumbResetFixture(t, true)
	_, nid, _ := cachedThumb(t, store, dir, "mine", "clip.mp4")

	first := getThumb(t, client, url, nid, "")
	defer first.Body.Close()
	require.Equal(t, http.StatusOK, first.StatusCode)
	etag := first.Header.Get("ETag")
	require.NotEmpty(t, etag, "without a validator the browser has nothing to revalidate with")
	// ⚠ Not max-age: a long freshness window under a stable URL is the bug.
	assert.Equal(t, "private, no-cache", first.Header.Get("Cache-Control"))

	second := getThumb(t, client, url, nid, etag)
	defer second.Body.Close()
	assert.Equal(t, http.StatusNotModified, second.StatusCode, "an unchanged thumbnail costs no bytes")
}

// The regression that started all this: after a regeneration the SAME URL with
// the SAME conditional request must return fresh bytes.
func TestThumbServe_RegeneratedThumbnailIsNotServedFromTheBrowserCache(t *testing.T) {
	client, store, dir, _, url := thumbResetFixture(t, true)
	_, nid, path := cachedThumb(t, store, dir, "mine", "clip.mp4")

	first := getThumb(t, client, url, nid, "")
	defer first.Body.Close()
	require.Equal(t, http.StatusOK, first.StatusCode)
	stale := first.Header.Get("ETag")
	require.NotEmpty(t, stale)

	// Stand in for a regeneration: same node, same path, different bytes.
	require.NoError(t, os.WriteFile(path, []byte("a real video frame, this time"), 0o644))

	fresh := getThumb(t, client, url, nid, stale)
	defer fresh.Body.Close()
	require.Equal(t, http.StatusOK, fresh.StatusCode, "the client must NOT be told its copy is still good")
	assert.NotEqual(t, stale, fresh.Header.Get("ETag"))
}

// FILEX_THUMBS_ENABLED=false: the reset surface goes with the feature rather
// than clearing a cache nothing will refill.
func TestThumbsReset_WithThumbnailsSwitchedOffIs503(t *testing.T) {
	dir := t.TempDir()
	backfills := 0
	srv, client, store := testutil.NewTestServerWith(t, nil, func(d *api.Deps) {
		p := thumb.New(d.Store, dir, thumb.Capabilities{Image: true})
		p.Disable() // what the bootstrap does for FILEX_THUMBS_ENABLED=false
		d.Thumbs = p
		d.ThumbBackfill = func([]int64) { backfills++ }
	})
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)
	sid, _, path := cachedThumb(t, store, dir, "mine", "clip.mp4")

	resp, err := client.Post(srv.URL+"/api/admin/storages/"+strconv.FormatInt(sid, 10)+"/thumbs/reset", "", nil)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	require.FileExists(t, path, "a refused reset must not have cleared anything")
	assert.Zero(t, backfills)
}

// A small image is served as its own file, with no cached JPEG behind it — and
// that response has to carry a validator and a length like any other.
//
// ⚠ The regression this exists for: the first cut of that path took its
// validator from node.Etag, which a LOCAL storage never fills. The answer was
// then `no-cache` with nothing to revalidate against, so every visit to the
// folder re-downloaded the whole picture and the tile appeared with a visible
// delay — the one thing serving the original was supposed to avoid.
func TestThumbServe_OriginalTileCarriesAValidatorWithoutAnEtag(t *testing.T) {
	root := t.TempDir()
	cache := t.TempDir()
	var pipe *thumb.Pipeline
	srv, client, store := testutil.NewTestServerWith(t, nil, func(d *api.Deps) {
		pipe = thumb.New(d.Store, cache, thumb.Capabilities{Image: true})
		d.Thumbs = pipe
	})
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)

	ctx := t.Context()
	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "kucuk", Driver: "local", MountPath: "kucuk", Enabled: true, ConfigJSON: []byte(`{}`),
	})
	require.NoError(t, err)
	pipe.AttachStorage(st.ID, drv)

	body := []byte("not really a PNG, but bytes with a length")
	require.NoError(t, os.WriteFile(filepath.Join(root, "kucuk.png"), body, 0o644))
	// No Etag on the row: exactly what a local storage catalogues.
	n, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "kucuk.png", Path: "/kucuk.png",
		PathHash: pathkey.Hash(st.ID, "/kucuk.png"), Type: model.NodeTypeFile, Size: int64(len(body)),
	})
	require.NoError(t, err)
	require.Empty(t, n.Etag, "the fixture is only honest while the row has no etag")
	require.NoError(t, store.UpsertThumbnail(ctx, &model.Thumbnail{
		NodeID: n.ID, State: "ready", StorageKey: thumb.OriginalKey,
	}))

	first := getThumb(t, client, srv.URL, n.ID, "")
	defer first.Body.Close()
	require.Equal(t, http.StatusOK, first.StatusCode)
	etag := first.Header.Get("ETag")
	require.NotEmpty(t, etag, "without a validator every visit re-downloads the picture")
	assert.Equal(t, strconv.Itoa(len(body)), first.Header.Get("Content-Length"))
	assert.Contains(t, first.Header.Get("Cache-Control"), "max-age")

	second := getThumb(t, client, srv.URL, n.ID, etag)
	defer second.Body.Close()
	assert.Equal(t, http.StatusNotModified, second.StatusCode, "an unchanged file costs no bytes")
}
