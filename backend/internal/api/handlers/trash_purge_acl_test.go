package handlers_test

// Purging one's own trash, from the side of an account that may look but not
// destroy.
//
// `mayPurge` asks for ≥editor on the ORIGINAL path — the level that let the
// caller delete the file in the first place — and a viewer sees the entry in
// the listing without being able to finish it off. The suite around these
// routes drove them with no ACL resolver attached, where every path is allowed
// by definition, so the whole rule rested on the source alone.
//
// A refusal is checked as a refusal on disk and in the catalogue, not only as a
// status code: `PurgeOne` deletes bytes, and a half-applied refusal is not a
// refusal.

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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/trash"
)

type purgeACLFixture struct {
	store  db.Store
	svc    *trash.Service
	router chi.Router
	root   string
	drv    storage.Driver
	st     *model.Storage
	// mine is the entry under `Ekip`; theirs is the one under `Baskasi`, which
	// no account in this fixture holds anything on.
	mine, theirs *model.Node
	// Neither is an admin: an admin is Owner everywhere by definition.
	viewer, editor *model.User
}

func newPurgeACLFixture(t *testing.T) *purgeACLFixture {
	t.Helper()
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	root := t.TempDir()

	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(root) + `"}`),
	})
	require.NoError(t, err)

	f := &purgeACLFixture{store: store, root: root, drv: drv, st: st}
	f.svc = trash.New(store, func(int64) (storage.Driver, error) { return drv, nil }, nil)
	h := handlers.NewTrash(f.svc, store)
	h.AttachACL(acl.New(store))
	r := chi.NewRouter()
	r.Post("/manager/trash/empty", h.EmptySelf)
	r.Delete("/manager/trash/{id}", h.PurgeSelf)
	f.router = r

	f.mine = f.binned(t, "Ekip/notlar.md", "takim notlari")
	f.theirs = f.binned(t, "Baskasi/plan.md", "baskasinin plani")

	f.viewer = testutil.SeedUser(t, store, "okuyucu@filex.test", "TestUserPass!1")
	f.editor = testutil.SeedUser(t, store, "yazar@filex.test", "TestUserPass!1")
	testutil.GrantPath(t, store, st.ID, f.viewer.ID, "Ekip", model.GrantViewer)
	testutil.GrantPath(t, store, st.ID, f.editor.ID, "Ekip", model.GrantEditor)
	return f
}

// binned writes a file, catalogues it, then deletes it the way every delete
// surface in filex does: bytes into `.filex-trash/`, row flagged, original path
// kept in storage_key — which is the path the purge guard judges.
func (f *purgeACLFixture) binned(t *testing.T, rel, content string) *model.Node {
	t.Helper()
	ctx := context.Background()
	abs := filepath.Join(f.root, filepath.FromSlash(rel))
	require.NoError(t, os.MkdirAll(filepath.Dir(abs), 0o755))
	require.NoError(t, os.WriteFile(abs, []byte(content), 0o644))
	clean := "/" + rel
	n, err := f.store.CreateNode(ctx, &model.Node{
		StorageID: f.st.ID, Name: filepath.Base(rel), Path: clean,
		PathHash: pathkey.Hash(f.st.ID, clean), StorageKey: clean,
		Type: model.NodeTypeFile, Size: int64(len(content)),
	})
	require.NoError(t, err)
	out, err := trash.Put(ctx, f.drv, rel)
	require.NoError(t, err)
	require.True(t, out.Trashed)
	key := "/" + out.Key
	require.NoError(t, f.store.SoftDeleteAndRetag(ctx, n.ID, key, pathkey.Hash(f.st.ID, key), clean))
	return n
}

func (f *purgeACLFixture) do(t *testing.T, as *model.User, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req.WithContext(auth.WithUser(req.Context(), as)))
	return rec
}

// stillInTheTrash asserts the entry survived intact: the row is soft-deleted,
// and the bytes are still under `.filex-trash/`, which together is the whole of
// what "restorable" means.
func (f *purgeACLFixture) stillInTheTrash(t *testing.T, n *model.Node, base string) {
	t.Helper()
	got, err := f.store.GetNode(context.Background(), n.ID)
	require.NoError(t, err)
	require.NotNil(t, got, "a refused purge must leave the row where it was")
	assert.NotNil(t, got.DeletedAt)
	left, err := filepath.Glob(filepath.Join(f.root, trash.Prefix, "*__"+base))
	require.NoError(t, err)
	assert.Len(t, left, 1, "and the bytes with it — a refusal that deleted them is not a refusal")
}

func TestTrashPurgeSelf_AViewerIsRefusedAndTheEntryStaysRestorable(t *testing.T) {
	f := newPurgeACLFixture(t)
	target := "/manager/trash/" + strconv.FormatInt(f.mine.ID, 10)

	rec := f.do(t, f.viewer, http.MethodDelete, target)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	f.stillInTheTrash(t, f.mine, "notlar.md")

	// Restorable is checked by restoring it: the file comes back where it was,
	// with its bytes, which is what the viewer's refusal was protecting.
	require.NoError(t, f.svc.Restore(context.Background(), f.mine.ID))
	body, err := os.ReadFile(filepath.Join(f.root, "Ekip", "notlar.md"))
	require.NoError(t, err)
	assert.Equal(t, "takim notlari", string(body))
}

func TestTrashPurgeSelf_AnEditorOnTheOriginalPathMayFinishTheJob(t *testing.T) {
	f := newPurgeACLFixture(t)

	rec := f.do(t, f.editor, http.MethodDelete, "/manager/trash/"+strconv.FormatInt(f.mine.ID, 10))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	got, err := f.store.GetNode(context.Background(), f.mine.ID)
	assert.True(t, err != nil || got == nil, "the row is gone for good")
	left, err := filepath.Glob(filepath.Join(f.root, trash.Prefix, "*__notlar.md"))
	require.NoError(t, err)
	assert.Empty(t, left)

	// The grant is on `Ekip`, and it stops there: somebody else's deletion is
	// not the editor's to destroy.
	denied := f.do(t, f.editor, http.MethodDelete, "/manager/trash/"+strconv.FormatInt(f.theirs.ID, 10))
	assert.Equal(t, http.StatusForbidden, denied.Code, denied.Body.String())
	f.stillInTheTrash(t, f.theirs, "plan.md")
}

// "Empty trash" skips what it may not purge rather than failing altogether — a
// shared drive where somebody else deleted something must not make the button
// answer an error. For a viewer that means the whole listing is skipped and
// nothing at all is destroyed.
func TestTrashEmptySelf_AViewerPurgesNothingAndDestroysNothing(t *testing.T) {
	f := newPurgeACLFixture(t)

	rec := f.do(t, f.viewer, http.MethodPost, "/manager/trash/empty")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got struct {
		Purged  int  `json:"purged"`
		Failed  int  `json:"failed"`
		Skipped int  `json:"skipped"`
		More    bool `json:"more"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Zero(t, got.Purged, "a viewer may look at the trash, not empty it")
	assert.Zero(t, got.Failed)
	assert.Equal(t, 2, got.Skipped)
	assert.False(t, got.More)

	f.stillInTheTrash(t, f.mine, "notlar.md")
	f.stillInTheTrash(t, f.theirs, "plan.md")
}

func TestTrashEmptySelf_AnEditorEmptiesOnlyWhatTheGrantCovers(t *testing.T) {
	f := newPurgeACLFixture(t)

	rec := f.do(t, f.editor, http.MethodPost, "/manager/trash/empty")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got struct {
		Purged  int `json:"purged"`
		Failed  int `json:"failed"`
		Skipped int `json:"skipped"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, 1, got.Purged)
	assert.Zero(t, got.Failed)
	assert.Equal(t, 1, got.Skipped, "the entry outside the grant is skipped, not refused")

	gone, err := f.store.GetNode(context.Background(), f.mine.ID)
	assert.True(t, err != nil || gone == nil)
	f.stillInTheTrash(t, f.theirs, "plan.md")
}
