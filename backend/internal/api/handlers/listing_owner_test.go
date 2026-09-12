package handlers_test

// The Owner column, on the listings that are not folder listings.
//
// Starred, recently opened and search answer with node rows. Those rows have
// always carried `owner_id` — it is a column — but nothing carried the NAME,
// and a column that renders a number is a column nobody reads. So the client
// had nothing to print and fell back to naming the person LOOKING at the list
// as the owner of everything in it. On a shared drive that is not a cosmetic
// default: it is a false statement about who put the file there.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestStarredAndRecent_NameTheOwnerRatherThanOnlyNumberingThem(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)

	reader, err := store.CreateUser(ctx, "okuyan@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	writer, err := store.CreateUser(ctx, "yazan@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	// The DISPLAY name is what the column may print. It used to fall back to the
	// address when an account had set none, which published every colleague's
	// e-mail to everybody holding viewer on the drive.
	require.NoError(t, store.UpdateUserDisplayName(ctx, writer.ID, "Yazan Bey"))

	mk := func(name string, owner *int64) *model.Node {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			StorageKey: p, Type: model.NodeTypeFile,
		})
		require.NoError(t, cerr)
		if owner != nil {
			require.NoError(t, store.SetNodeOwner(ctx, n.ID, owner))
		}
		return n
	}
	// One file somebody else uploaded, one the storage sync merely found.
	theirs := mk("onun.md", &writer.ID)
	found := mk("bulunan.md", nil)

	h := handlers.NewMeta(store)
	for _, n := range []*model.Node{theirs, found} {
		require.NoError(t, store.SetUserNodeMeta(ctx, reader.ID, n.ID, "starred", "1"))
		require.NoError(t, store.SetUserNodeMeta(ctx, reader.ID, n.ID, "last_opened", "1"))
	}

	for _, route := range []struct {
		name string
		call http.HandlerFunc
	}{{"starred", h.ListStarred}, {"recent", h.ListRecent}} {
		t.Run(route.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/?limit=50", nil)
			rec := httptest.NewRecorder()
			route.call(rec, req.WithContext(auth.WithUser(req.Context(), reader)))
			require.Equal(t, http.StatusOK, rec.Code)

			var body struct {
				Nodes []struct {
					Name      string `json:"name"`
					OwnerID   *int64 `json:"owner_id"`
					OwnerName string `json:"owner_name"`
				} `json:"nodes"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			byName := map[string]string{}
			owned := map[string]bool{}
			for _, n := range body.Nodes {
				byName[n.Name] = n.OwnerName
				owned[n.Name] = n.OwnerID != nil
			}
			assert.Equal(t, "Yazan Bey", byName["onun.md"],
				"the name, not only the id: the reader has to be able to see it is not theirs")
			assert.NotContains(t, rec.Body.String(), "yazan@filex.test",
				"the name they chose, never the address behind it")
			assert.True(t, owned["onun.md"])
			// "unowned" and "owned by nobody in particular" are different statements,
			// and a row the sync found carries neither field rather than a blank one.
			assert.Empty(t, byName["bulunan.md"])
			assert.False(t, owned["bulunan.md"])
		})
	}
}
