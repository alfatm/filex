package handlers_test

// Emptying one's OWN trash. Until these two routes existed, purging was an
// admin action (`/api/admin/trash/*`), so an ordinary account had a room it
// could put things into and never take anything out of: deleted items sat there
// until the retention sweep came round, and the end-user app had to keep
// "Delete forever" and "Empty trash" switched off.
//
// The dangerous half is the guard, not the purge. `PurgeOne` takes the bytes at
// the row's CURRENT path, which for a live row is where the file still is — so
// a purge route that does not first establish "this node is in the trash" is a
// delete-anything-by-id route wearing a different name.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/trash"
)

type purgeFixture struct {
	store  db.Store
	svc    *trash.Service
	router chi.Router
	st     *model.Storage
	root   string
	drv    storage.Driver
}

func newPurgeFixture(t *testing.T) *purgeFixture {
	t.Helper()
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

	svc := trash.New(store, func(int64) (storage.Driver, error) { return drv, nil }, nil)
	h := handlers.NewTrash(svc, store)
	r := chi.NewRouter()
	r.Post("/manager/trash/empty", h.EmptySelf)
	r.Delete("/manager/trash/{id}", h.PurgeSelf)

	return &purgeFixture{store: store, svc: svc, router: r, st: st, root: root, drv: drv}
}

// seed catalogues a node and, for a file, writes its bytes.
func (f *purgeFixture) seed(t *testing.T, rel, content string, kind model.NodeType, parent *int64) *model.Node {
	t.Helper()
	abs := filepath.Join(f.root, filepath.FromSlash(rel))
	if kind == model.NodeTypeDirectory {
		require.NoError(t, os.MkdirAll(abs, 0o755))
	} else {
		require.NoError(t, os.MkdirAll(filepath.Dir(abs), 0o755))
		require.NoError(t, os.WriteFile(abs, []byte(content), 0o644))
	}
	clean := "/" + rel
	n, err := f.store.CreateNode(context.Background(), &model.Node{
		StorageID: f.st.ID, ParentID: parent, Name: filepath.Base(rel),
		Path: clean, PathHash: pathkey.Hash(f.st.ID, clean), StorageKey: clean,
		Type: kind, Size: int64(len(content)),
	})
	require.NoError(t, err)
	return n
}

// bin moves a node's bytes into `.filex-trash/` and flags the row, which is what
// every delete surface in filex does (trash.Put + SoftDeleteAndRetag).
func (f *purgeFixture) bin(t *testing.T, n *model.Node) {
	t.Helper()
	ctx := context.Background()
	rel := n.Path[1:]
	out, err := trash.Put(ctx, f.drv, rel)
	require.NoError(t, err)
	require.True(t, out.Trashed, "the fixture's own delete must reach the trash")
	key := "/" + out.Key
	require.NoError(t, f.store.SoftDeleteAndRetag(ctx, n.ID, key, pathkey.Hash(f.st.ID, key), n.Path))
}

func (f *purgeFixture) do(t *testing.T, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestTrashPurgeSelf_DestroysOneEntry(t *testing.T) {
	f := newPurgeFixture(t)
	n := f.seed(t, "Docs/notes.md", "merhaba", model.NodeTypeFile, nil)
	f.bin(t, n)

	rec := f.do(t, http.MethodDelete, "/manager/trash/"+strconv.FormatInt(n.ID, 10))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	got, err := f.store.GetNode(context.Background(), n.ID)
	require.True(t, err != nil || got == nil, "the row is gone for good, not soft-deleted again")
	left, err := filepath.Glob(filepath.Join(f.root, trash.Prefix, "*__notes.md"))
	require.NoError(t, err)
	require.Empty(t, left, "the bytes in the trash go with the row")
}

func TestTrashPurgeSelf_RefusesALiveNode(t *testing.T) {
	f := newPurgeFixture(t)
	live := f.seed(t, "Docs/notes.md", "duruyor", model.NodeTypeFile, nil)

	rec := f.do(t, http.MethodDelete, "/manager/trash/"+strconv.FormatInt(live.ID, 10))
	require.Equal(t, http.StatusNotFound, rec.Code, "a live node is not a trash entry")

	got, err := f.store.GetNode(context.Background(), live.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Nil(t, got.DeletedAt, "and nothing about it changed")
	body, err := os.ReadFile(filepath.Join(f.root, "Docs", "notes.md"))
	require.NoError(t, err, "the file the user is still using must be untouched")
	require.Equal(t, "duruyor", string(body))
}

func TestTrashEmptySelf_TakesTheContentsOfADeletedFolderWithIt(t *testing.T) {
	f := newPurgeFixture(t)
	dir := f.seed(t, "Docs", "", model.NodeTypeDirectory, nil)
	inner := f.seed(t, "Docs/notes.md", "icerik", model.NodeTypeFile, &dir.ID)
	f.bin(t, dir)

	// One deletion, one row to purge: the file inside is not a second entry.
	entries, _, err := f.svc.List(context.Background(), nil, true, db.NodeFacets{}, 50, 0)
	require.NoError(t, err)
	require.Len(t, entries, 1)

	rec := f.do(t, http.MethodPost, "/manager/trash/empty")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got struct {
		Purged  int  `json:"purged"`
		Failed  int  `json:"failed"`
		Skipped int  `json:"skipped"`
		More    bool `json:"more"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Equal(t, 1, got.Purged)
	require.Zero(t, got.Failed)
	require.Zero(t, got.Skipped)
	require.False(t, got.More)

	for _, id := range []int64{dir.ID, inner.ID} {
		n, err := f.store.GetNode(context.Background(), id)
		require.True(t, err != nil || n == nil, "everything under the deleted folder goes too")
	}
	rest, _, err := f.svc.List(context.Background(), nil, false, db.NodeFacets{}, 50, 0)
	require.NoError(t, err)
	require.Empty(t, rest, "the trash is empty afterwards, by its own listing")
}
