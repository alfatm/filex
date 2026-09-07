package handlers_test

// GET /api/files/storages — the drive list an ordinary account may open.
//
// The endpoint exists so a client can draw its drive switcher without first
// listing a folder, and the only thing it must never do is widen visibility:
// the answer has to match, storage for storage, what `?q=index` already
// reports in its `storages` field.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type userStorageRow struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"read_only"`
}

func userStorages(t *testing.T, client *http.Client, base string) []userStorageRow {
	t.Helper()
	st, raw := doReq(t, client, http.MethodGet, base+"/api/files/storages", nil)
	require.Equal(t, http.StatusOK, st, "storages: %s", raw)
	var out struct {
		Storages []userStorageRow `json:"storages"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	return out.Storages
}

func storageNamesOf(rows []userStorageRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Name)
	}
	return out
}

// seedReadOnlyStorage is seedStorage's read-only twin; the flag is the one
// field of the row this endpoint reports besides the name.
func seedReadOnlyStorage(t *testing.T, store db.Store, name string) *model.Storage {
	t.Helper()
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name:       name,
		Driver:     "local",
		MountPath:  "/" + name,
		ConfigJSON: json.RawMessage(`{"root":"/tmp/filex-storages-test/` + name + `"}`),
		SyncMode:   model.SyncModeOnDemand,
		Enabled:    true,
		ReadOnly:   true,
	})
	require.NoError(t, err)
	return st
}

// An RBAC-off storage is everyone's; an RBAC-on one is nobody's until granted.
func TestUserStorages_RBACHidesUngrantedDrives(t *testing.T) {
	srv, _, store := testutil.NewTestServer(t)

	seedStorage(t, store, "mine", false)        // reachable by role
	team := seedStorage(t, store, "team", true) // reachable only via grants
	seedReadOnlyStorage(t, store, "archive")

	u := seedSharedUser(t, store, "s@test.local", "UserPass1!")
	client := freshClient(t)
	testutil.LoginAs(t, srv, client, "s@test.local", "UserPass1!")

	got := userStorages(t, client, srv.URL)
	assert.Equal(t, []string{"mine", "archive"}, storageNamesOf(got),
		"the RBAC-on drive is invisible while the caller holds no grant in it")
	assert.Equal(t, []userStorageRow{{Name: "mine"}, {Name: "archive", ReadOnly: true}}, got,
		"read_only travels with the row: a client must not offer uploads into a drive that refuses them")

	// One grant anywhere inside the drive makes the drive itself visible.
	seedNode(t, store, team, "Projects", true)
	grant(t, store, team, u, "Projects", model.GrantViewer, true)
	assert.Equal(t, []string{"mine", "team", "archive"}, storageNamesOf(userStorages(t, client, srv.URL)))
}

// Signing in is the whole gate: there is no anonymous drive list.
func TestUserStorages_RequiresAuth(t *testing.T) {
	srv, _, store := testutil.NewTestServer(t)
	seedStorage(t, store, "mine", false)

	st, _ := doReq(t, freshClient(t), http.MethodGet, srv.URL+"/api/files/storages", nil)
	assert.Equal(t, http.StatusUnauthorized, st)
}
