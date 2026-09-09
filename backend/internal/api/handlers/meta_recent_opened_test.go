package handlers_test

// Recent is ordered by when a file was OPENED, and the row has to say so.
//
// The date lives on the user_node_meta row the listing joins and sorts by, not
// on the node, so a row that carries only the node reaches the client with one
// date on it: the file's mtime. The client then sorts and groups by that —
// the only date it has — which reverses the server's order whenever the two
// disagree and dates "Today" by when a file was written rather than read.
//
// The fixture makes them disagree on purpose: the file opened most recently is
// the one written longest ago.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestListRecent_CarriesTheOpenDateItIsOrderedBy(t *testing.T) {
	ctx := context.Background()
	sqlDB, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	reader, err := store.CreateUser(ctx, "okuyan@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)

	// The open times are written straight onto the meta row: SetUserNodeMeta
	// stamps CURRENT_TIMESTAMP, whose one-second resolution cannot separate two
	// calls in the same test.
	open := func(n *model.Node, at time.Time) {
		require.NoError(t, store.SetUserNodeMeta(ctx, reader.ID, n.ID, "last_opened", "1"))
		_, uerr := sqlDB.ExecContext(ctx,
			`UPDATE user_node_meta SET updated_at=? WHERE user_id=? AND node_id=? AND key='last_opened'`,
			at.UTC().Format("2006-01-02 15:04:05"), reader.ID, n.ID)
		require.NoError(t, uerr)
	}
	mk := func(name string, written time.Time) *model.Node {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			StorageKey: p, Type: model.NodeTypeFile, BackendMtime: &written,
		})
		require.NoError(t, cerr)
		return n
	}

	now := time.Now().UTC().Truncate(time.Second)
	// Written last week, read a minute ago — the top row of Recent.
	old := mk("eski.md", now.Add(-7*24*time.Hour))
	openedNow := now.Add(-time.Minute)
	// Written a minute ago, read last week — the bottom row, and the top one
	// for anybody sorting by mtime.
	fresh := mk("yeni.md", now.Add(-time.Minute))
	openedLongAgo := now.Add(-7 * 24 * time.Hour)
	open(old, openedNow)
	open(fresh, openedLongAgo)

	req := httptest.NewRequest(http.MethodGet, "/?limit=50", nil)
	rec := httptest.NewRecorder()
	handlers.NewMeta(store).ListRecent(rec, req.WithContext(auth.WithUser(req.Context(), reader)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body struct {
		Nodes []struct {
			Name         string     `json:"name"`
			OpenedAt     *time.Time `json:"opened_at"`
			BackendMtime *time.Time `json:"backend_mtime"`
		} `json:"nodes"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Nodes, 2)

	assert.Equal(t, []string{"eski.md", "yeni.md"}, []string{body.Nodes[0].Name, body.Nodes[1].Name},
		"newest-opened first")
	require.NotNil(t, body.Nodes[0].OpenedAt, "the row has to carry the date it is ordered by")
	require.NotNil(t, body.Nodes[1].OpenedAt)
	assert.Equal(t, openedNow.Unix(), body.Nodes[0].OpenedAt.Unix())
	assert.Equal(t, openedLongAgo.Unix(), body.Nodes[1].OpenedAt.Unix())
	// The point of the fixture: the dates disagree, so a client left with only
	// the mtime would put these two the other way round.
	assert.True(t, body.Nodes[0].OpenedAt.After(*body.Nodes[1].OpenedAt))
	require.NotNil(t, body.Nodes[0].BackendMtime)
	require.NotNil(t, body.Nodes[1].BackendMtime)
	assert.True(t, body.Nodes[0].BackendMtime.Before(*body.Nodes[1].BackendMtime),
		"fixture: sorting these rows by mtime reverses them")
}
