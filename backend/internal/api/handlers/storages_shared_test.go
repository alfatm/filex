package handlers_test

// Which drives are SHARED with the caller, as the drive list reports it.
//
// The Owner column needs the answer: on a team drive, naming whichever
// colleague happened to upload each file is noise — everybody in the drive can
// see everybody's files, and what the reader needs to know is that the drive is
// not theirs. So the column names the drive there, and that is only possible if
// the server says which drives those are.
//
// The test is the one `shared-with-me` already makes, and the two edges are
// what make it correct rather than merely plausible: an admin reaches
// everything by role, so no drive is "shared with" them; and on an RBAC-off
// drive a grant is inert, so the files there are simply the account's own.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// sharedFlags drives the handler as `as` and returns name → shared.
func sharedFlags(t *testing.T, store db.Store, as *model.User) map[string]bool {
	t.Helper()
	h := handlers.NewStoragesUser(store)
	h.AttachACL(acl.New(store))
	req := httptest.NewRequest(http.MethodGet, "/storages", nil)
	rec := httptest.NewRecorder()
	h.List(rec, req.WithContext(auth.WithUser(req.Context(), as)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body struct {
		Storages []struct {
			Name   string `json:"name"`
			Shared bool   `json:"shared"`
		} `json:"storages"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	out := map[string]bool{}
	for _, s := range body.Storages {
		out[s.Name] = s.Shared
	}
	return out
}

func TestStoragesUser_SaysWhichDrivesAreSharedWithTheCaller(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)

	mk := func(name string, rbac bool) *model.Storage {
		s, err := store.CreateStorage(ctx, &model.Storage{
			Name: name, Driver: "local", MountPath: "/" + name, Enabled: true, RBACEnabled: rbac,
			ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
		})
		require.NoError(t, err)
		return s
	}
	team := mk("team", true)  // reached through a grant
	open := mk("open", false) // RBAC off: everyone reaches it by role

	member, err := store.CreateUser(ctx, "uye@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	boss, err := store.CreateUser(ctx, "yonetici@filex.test", "x", model.RoleAdmin, "en", "UTC")
	require.NoError(t, err)

	_, err = store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: team.ID, UserID: member.ID, PathPrefix: "", Level: "editor",
	})
	require.NoError(t, err)
	// A grant on the RBAC-off drive too, to prove it is ignored rather than
	// merely absent from the fixture.
	_, err = store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: open.ID, UserID: member.ID, PathPrefix: "", Level: "editor",
	})
	require.NoError(t, err)

	forMember := sharedFlags(t, store, member)
	assert.True(t, forMember["team"], "reached through a grant on an RBAC drive — a shared drive")
	assert.False(t, forMember["open"], "RBAC is off there, so the grant is inert and the files are just theirs")

	forBoss := sharedFlags(t, store, boss)
	assert.False(t, forBoss["team"], "an admin reaches everything by role; no drive is shared WITH them")
	assert.False(t, forBoss["open"])
}
