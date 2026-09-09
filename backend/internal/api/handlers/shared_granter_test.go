package handlers_test

// "Shared with me" has to say WHO shared each item.
//
// The row carried `shared_at` and nothing else about the grant, so the column
// rendered an initial-less avatar and a dash — while `file_grants.created_by`
// had the answer all along.
//
// The second half of the test is the constraint on the answer: the name is the
// display name and only the display name. The other name lookups in this API
// fall back to the account's e-mail, and this is the one listing whose purpose
// is to show one account's details to another — falling back here would hand
// every recipient of a share the granter's e-mail address.

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestSharedWithMe_NamesTheGranterWithoutLeakingTheirEmail(t *testing.T) {
	srv, _, store := testutil.NewTestServer(t)
	ctx := context.Background()

	team := seedStorage(t, store, "team", true)
	recipient := seedSharedUser(t, store, "alici@test.local", "UserPass1!")

	named := seedSharedUser(t, store, "ayse@test.local", "UserPass1!")
	require.NoError(t, store.UpdateUserDisplayName(ctx, named.ID, "Ayşe Yılmaz"))
	// An account that never set a display name — the common case, and the one
	// where the e-mail is the tempting fallback.
	anonymous := seedSharedUser(t, store, "kerem@test.local", "UserPass1!")

	seedNode(t, store, team, "Raporlar", true)
	seedNode(t, store, team, "Notlar", true)
	for _, g := range []struct {
		rel string
		by  *model.User
	}{{"Raporlar", named}, {"Notlar", anonymous}} {
		_, err := store.CreateFileGrant(ctx, &model.FileGrant{
			StorageID: team.ID, PathPrefix: g.rel, IsDir: true,
			UserID: recipient.ID, Level: model.GrantEditor, CreatedBy: &g.by.ID,
		})
		require.NoError(t, err)
	}

	client := freshClient(t)
	testutil.LoginAs(t, srv, client, "alici@test.local", "UserPass1!")
	status, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/files/manager/shared-with-me", nil)
	require.Equal(t, http.StatusOK, status, "shared-with-me: %s", raw)

	rows := map[string]map[string]any{}
	for _, r := range sharedWithMe(t, client, srv.URL).Files {
		rows[r["path"].(string)] = r
	}
	require.Contains(t, rows, "team://Raporlar")
	require.Contains(t, rows, "team://Notlar")

	byName := rows["team://Raporlar"]
	assert.Equal(t, "Ayşe Yılmaz", byName["shared_by_name"],
		"the recipient has to be able to see who shared it, not only when")
	assert.Equal(t, float64(named.ID), byName["shared_by"], "and the id behind the name")

	// No display name: the id, and nothing that identifies the person. The
	// client names them in the reader's own language.
	unnamed := rows["team://Notlar"]
	assert.Equal(t, float64(anonymous.ID), unnamed["shared_by"])
	assert.NotContains(t, unnamed, "shared_by_name",
		"an account with no display name is reported by id alone")

	for _, email := range []string{"ayse@test.local", "kerem@test.local"} {
		assert.False(t, strings.Contains(string(raw), email),
			"the granter's e-mail must not reach another account: %s", raw)
	}
}
