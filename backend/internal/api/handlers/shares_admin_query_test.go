package handlers_test

// GET /api/admin/shares must honour the query the admin SPA actually sends.
//
// The SPA asks with `q` / `page` / `page_size` / `active_only`; the handler read
// only `active` / `limit` / `offset`, so the Shares page's search box and pager
// were inert — every page came back as the same first rows, and a revoked link
// could not be filtered out of the way.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type adminSharesResp struct {
	Items []struct {
		Share struct {
			ID        int64      `json:"id"`
			Token     string     `json:"token"`
			RevokedAt *time.Time `json:"revoked_at"`
		} `json:"share"`
		NodePath string `json:"node_path"`
	} `json:"items"`
	Total int64 `json:"total"`
}

func getAdminShares(t *testing.T, srv, query string, client *http.Client) adminSharesResp {
	t.Helper()
	resp, err := client.Get(srv + "/api/admin/shares?" + query)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out adminSharesResp
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return out
}

// seedAdminShare mints one link on a node of its own named `name`.
func seedAdminShare(t *testing.T, store db.Store, ownerID int64, name, token string) *model.Share {
	t.Helper()
	ctx := context.Background()
	stg, err := store.CreateStorage(ctx, &model.Storage{
		Name: "st-" + token, Driver: "local", MountPath: "/", SyncMode: model.SyncModePoll, SyncIntervalS: 900, Enabled: true,
	})
	require.NoError(t, err)
	n, err := store.CreateNode(ctx, &model.Node{
		StorageID: stg.ID, Name: name, Path: "/" + name, PathHash: "h-" + token, Type: model.NodeTypeFile,
		SyncState: model.SyncStateSynced,
	})
	require.NoError(t, err)
	exp := time.Now().Add(7 * 24 * time.Hour).UTC()
	sh, err := store.CreateShare(ctx, &model.Share{NodeID: n.ID, Token: token, ExpiresAt: &exp, CreatedBy: &ownerID})
	require.NoError(t, err)
	return sh
}

func TestAdminShares_HonoursSearchPagingAndActiveFilter(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)
	admin, err := store.GetUserByEmail(context.Background(), email)
	require.NoError(t, err)

	seedAdminShare(t, store, admin.ID, "quarterly.pdf", "tok-quarterly")
	seedAdminShare(t, store, admin.ID, "holiday.jpg", "tok-holiday")
	closed := seedAdminShare(t, store, admin.ID, "old.txt", "tok-closed")
	require.NoError(t, store.RevokeShare(context.Background(), closed.ID))

	t.Run("q narrows to one link", func(t *testing.T) {
		got := getAdminShares(t, srv.URL, "q=quarterly", client)
		require.Equal(t, int64(1), got.Total)
		require.Len(t, got.Items, 1)
		assert.Equal(t, "tok-quarterly", got.Items[0].Share.Token)
	})

	t.Run("active_only hides the revoked link", func(t *testing.T) {
		got := getAdminShares(t, srv.URL, "active_only=true", client)
		assert.Equal(t, int64(2), got.Total)
		for _, item := range got.Items {
			assert.Nil(t, item.Share.RevokedAt)
		}
	})

	t.Run("the revoked link is still listed, and says it is revoked", func(t *testing.T) {
		got := getAdminShares(t, srv.URL, "", client)
		require.Equal(t, int64(3), got.Total)
		var seen bool
		for _, item := range got.Items {
			if item.Share.ID == closed.ID {
				seen = true
				assert.NotNil(t, item.Share.RevokedAt, "revoked_at is how the admin page tells revoked from expired")
			}
		}
		assert.True(t, seen)
	})

	t.Run("page_size and page cut the list into pages", func(t *testing.T) {
		first := getAdminShares(t, srv.URL, "page_size=2&page=1", client)
		require.Len(t, first.Items, 2)
		second := getAdminShares(t, srv.URL, "page_size=2&page=2", client)
		require.Len(t, second.Items, 1, "page 2 must be the remainder, not the first page again")
		assert.NotEqual(t, first.Items[0].Share.ID, second.Items[0].Share.ID)
	})

	t.Run("the older limit/offset spelling still works", func(t *testing.T) {
		got := getAdminShares(t, srv.URL, fmt.Sprintf("limit=%d&offset=0&active=true", 2), client)
		require.Len(t, got.Items, 2)
		assert.Equal(t, int64(2), got.Total)
	})
}
