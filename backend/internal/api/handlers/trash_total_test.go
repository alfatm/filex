package handlers_test

// `total` on the trash listing is the number of trashed rows the query matched,
// and the page count is not that number.
//
// Confinement and RBAC cannot be expressed in the query — a tenant root and a
// set of path-prefix grants are not columns — so both run over the page that
// comes back. They used to end by writing `total = len(kept)`, which capped the
// figure at the page size for everyone, admins included: the admin trash screen
// asks for fifty rows and printed "50 items in the trash" over a trash holding
// hundreds, and no pager could ever be built on it.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/trash"
)

// listTrash drives the handler as `as` and returns the decoded answer.
func listTrash(t *testing.T, h *handlers.Trash, as *model.User, query string) (entries []map[string]any, total int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/manager/trash?"+query, nil)
	rec := httptest.NewRecorder()
	h.List(rec, req.WithContext(auth.WithUser(req.Context(), as)))
	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body.Entries, body.Total
}

func TestTrashList_TotalCountsTheTrashNotThePage(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	admin, err := store.CreateUser(ctx, "yonetici@filex.test", "x", model.RoleAdmin, "en", "UTC")
	require.NoError(t, err)

	const trashed = 12
	for i := 0; i < trashed; i++ {
		p := fmt.Sprintf("/eski-%02d.md", i)
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: fmt.Sprintf("eski-%02d.md", i), Path: p,
			PathHash: pathkey.Hash(st.ID, p), StorageKey: p, Type: model.NodeTypeFile,
		})
		require.NoError(t, cerr)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}

	h := handlers.NewTrash(trash.New(store, func(int64) (storage.Driver, error) { return nil, nil }, nil), store)
	// An ACL resolver is wired, as it is in production. An admin is Owner
	// everywhere, so nothing is dropped — which is exactly the case the old
	// code still got wrong, because it overwrote the total regardless.
	h.AttachACL(acl.New(store))

	page, total := listTrash(t, h, admin, "limit=5")
	assert.Len(t, page, 5, "the page is the page")
	assert.Equal(t, trashed, total, "the total is the trash, not the page")
}

func TestTrashList_TotalDropsWhatThePageHidFromTheCaller(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	user, err := store.CreateUser(ctx, "kullanici@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)

	// Two deleted files; the caller holds a grant on one of them.
	for _, name := range []string{"gorunur.md", "gizli.md"} {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			StorageKey: p, Type: model.NodeTypeFile,
		})
		require.NoError(t, cerr)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}
	_, err = store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: st.ID, UserID: user.ID, PathPrefix: "gorunur.md", Level: "viewer",
	})
	require.NoError(t, err)

	h := handlers.NewTrash(trash.New(store, func(int64) (storage.Driver, error) { return nil, nil }, nil), store)
	h.AttachACL(acl.New(store))

	entries, total := listTrash(t, h, user, "limit=50")
	require.Len(t, entries, 1, "only the file the caller may see")
	assert.Equal(t, "gorunur.md", entries[0]["name"])
	assert.Equal(t, 1, total, "and the total drops what this page hid, rather than reporting both")
}
