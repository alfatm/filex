package handlers_test

// The version endpoints address a node by its NUMERIC id and used to ask for
// nothing else. That made two things possible for any authenticated account
// that could guess an id:
//
//   - read somebody else's revision history — every size, every date, and the
//     name of everyone who has ever written to the file;
//   - POST /restore and overwrite that file's live bytes with an older
//     revision, which is a destructive write on data the caller cannot even
//     open.
//
// Every test here is written from the second account's side: it holds no grant
// on the file and must be refused, while the account that does hold one must
// still be able to do the same thing.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	"github.com/brf-tech/filex/backend/internal/versioning"
)

type versionACLFixture struct {
	store    db.Store
	handler  *handlers.Versions
	root     string
	node     *model.Node
	owner    *model.User // holds an editor grant on the file
	stranger *model.User // holds nothing at all
}

// newVersionACLFixture builds one RBAC-enabled storage holding one file with a
// history, one account granted editor on it and one account granted nothing.
func newVersionACLFixture(t *testing.T) *versionACLFixture {
	t.Helper()
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	root := t.TempDir()

	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/data", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(fmt.Sprintf(`{"root":%q}`, root)),
	})
	require.NoError(t, err)

	const rel = "/Docs/maas.md"
	abs := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(rel, "/")))
	require.NoError(t, os.MkdirAll(filepath.Dir(abs), 0o755))
	require.NoError(t, os.WriteFile(abs, []byte("v1"), 0o644))
	node, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "maas.md", Path: rel, PathHash: pathkey.Hash(st.ID, rel),
		StorageKey: rel, Type: model.NodeTypeFile, Size: 2,
	})
	require.NoError(t, err)

	// Neither account is an admin: an admin is Owner everywhere by definition
	// and would prove nothing about the gate.
	owner, err := store.CreateUser(ctx, "sahip@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	stranger, err := store.CreateUser(ctx, "yabanci@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	_, err = store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: st.ID, UserID: owner.ID, PathPrefix: "Docs", Level: "editor",
	})
	require.NoError(t, err)

	svc := versioning.New(store, func(id int64) (storage.Driver, error) {
		if id != st.ID {
			return nil, fmt.Errorf("unknown storage %d", id)
		}
		return drv, nil
	})
	// A snapshot to have something worth stealing, then a change on disk so a
	// restore would visibly undo it.
	_, err = svc.Snapshot(ctx, node.ID)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(abs, []byte("v2-yeni"), 0o644))
	require.NoError(t, store.UpdateNodeMeta(ctx, node.ID, 7, node.Mime, "etag-v2", node.DBMtime))

	h := handlers.NewVersions(store, svc)
	h.AttachACL(acl.New(store))
	return &versionACLFixture{store: store, handler: h, root: root, node: node, owner: owner, stranger: stranger}
}

func (f *versionACLFixture) call(t *testing.T, as *model.User, h http.HandlerFunc, method, target string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	rec := httptest.NewRecorder()
	h(rec, req.WithContext(auth.WithUser(req.Context(), as)))
	return rec
}

func (f *versionACLFixture) liveBytes(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.root, "Docs", "maas.md"))
	require.NoError(t, err)
	return string(b)
}

func TestVersionsList_RefusesAnAccountThatCannotSeeTheFile(t *testing.T) {
	f := newVersionACLFixture(t)
	target := fmt.Sprintf("/versions?node_id=%d", f.node.ID)

	denied := f.call(t, f.stranger, f.handler.List, http.MethodGet, target, nil)
	assert.Equal(t, http.StatusForbidden, denied.Code,
		"403, not an empty timeline: an empty list is itself an answer about whether that id is a file with a history")

	allowed := f.call(t, f.owner, f.handler.List, http.MethodGet, target, nil)
	require.Equal(t, http.StatusOK, allowed.Code)
	var body struct {
		Versions []map[string]any `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(allowed.Body.Bytes(), &body))
	assert.Len(t, body.Versions, 1, "the account that holds the grant still reads the history")
}

func TestVersionsRestore_RefusesAnAccountThatCannotWriteTheFile(t *testing.T) {
	f := newVersionACLFixture(t)
	list := f.call(t, f.owner, f.handler.List, http.MethodGet, fmt.Sprintf("/versions?node_id=%d", f.node.ID), nil)
	require.Equal(t, http.StatusOK, list.Code)
	var body struct {
		Versions []struct {
			ID int64 `json:"id"`
		} `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &body))
	require.Len(t, body.Versions, 1)
	versionID := body.Versions[0].ID

	req := map[string]any{"node_id": f.node.ID, "version_id": versionID}
	denied := f.call(t, f.stranger, f.handler.Restore, http.MethodPost, "/versions/restore", req)
	assert.Equal(t, http.StatusForbidden, denied.Code)
	assert.Equal(t, "v2-yeni", f.liveBytes(t),
		"the refusal has to be a refusal on disk too, not only in the status code")

	allowed := f.call(t, f.owner, f.handler.Restore, http.MethodPost, "/versions/restore", req)
	require.Equal(t, http.StatusOK, allowed.Code)
	assert.Equal(t, "v1", f.liveBytes(t), "the editor's own restore still happens")
}

func TestVersionsSnapshot_RefusesAnAccountThatCannotWriteTheFile(t *testing.T) {
	f := newVersionACLFixture(t)
	req := map[string]any{"node_id": f.node.ID}

	denied := f.call(t, f.stranger, f.handler.Snapshot, http.MethodPost, "/versions/snapshot", req)
	assert.Equal(t, http.StatusForbidden, denied.Code,
		"a snapshot writes an object into a storage and bills it to a quota; it is a write like any other")

	allowed := f.call(t, f.owner, f.handler.Snapshot, http.MethodPost, "/versions/snapshot", req)
	assert.Equal(t, http.StatusOK, allowed.Code)
}

func TestVersions_UnknownNodeIsNotFoundRatherThanAnEmptyHistory(t *testing.T) {
	f := newVersionACLFixture(t)
	rec := f.call(t, f.owner, f.handler.List, http.MethodGet, "/versions?node_id=999999", nil)
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// A node in the trash keeps its history, and the grant that reaches it is the
// one on the folder the file was deleted OUT of. Soft-deleting renames the row
// to `.filex-trash/<ts>__name` and stashes the original path in `storage_key`;
// checking the guard against the renamed path meant the holder of a grant on
// `Docs/` was refused the history of a file they had just deleted from `Docs/`
// — the one moment "should I restore this?" makes the timeline worth reading.
func (f *versionACLFixture) bin(t *testing.T) {
	t.Helper()
	key := "/" + trash.NewKey("maas.md")
	require.NoError(t, f.store.SoftDeleteAndRetag(context.Background(), f.node.ID,
		key, pathkey.Hash(f.node.StorageID, key), f.node.Path))
}

func TestVersionsList_TrashedNodeIsJudgedByWhereItUsedToLive(t *testing.T) {
	f := newVersionACLFixture(t)
	f.bin(t)
	target := fmt.Sprintf("/versions?node_id=%d", f.node.ID)

	allowed := f.call(t, f.owner, f.handler.List, http.MethodGet, target, nil)
	require.Equal(t, http.StatusOK, allowed.Code, allowed.Body.String())
	var body struct {
		Versions []map[string]any `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(allowed.Body.Bytes(), &body))
	assert.Len(t, body.Versions, 1, "the editor on Docs/ still reads the history of what they deleted from it")

	denied := f.call(t, f.stranger, f.handler.List, http.MethodGet, target, nil)
	assert.Equal(t, http.StatusForbidden, denied.Code,
		"and the trash is not a way round the grant for an account that never had one")
}
