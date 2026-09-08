package handlers_test

// The promise the assistant's two-table schema exists to keep: an administrator
// may see that an account holds conversations and may delete one, and may not
// read a line of any of them — nor may another ordinary user.
//
// Tested through the real router, because the promise is about ROUTES. A store
// method that returns messages exists (the owner's own reading needs it); what
// must not exist is a way to reach it as somebody else.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestAssistantSessionsArePrivateToTheirOwner(t *testing.T) {
	srv, adminClient, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, adminClient, email, pw)

	createUser(t, srv.URL, adminClient, "ada@test.local", "AdaPass1!", model.RoleUser)
	createUser(t, srv.URL, adminClient, "mert@test.local", "MertPass1!", model.RoleUser)

	ada := freshClient(t)
	testutil.LoginAs(t, srv, ada, "ada@test.local", "AdaPass1!")
	mert := freshClient(t)
	testutil.LoginAs(t, srv, mert, "mert@test.local", "MertPass1!")

	// Ada starts a conversation.
	st, raw := doReq(t, ada, http.MethodPost, srv.URL+"/api/assistant/sessions", map[string]any{})
	require.Equal(t, http.StatusOK, st, "create: %s", raw)
	var created struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	require.NoError(t, json.Unmarshal(raw, &created))
	require.NotEmpty(t, created.Session.ID)

	// Her own reading works.
	st, _ = doReq(t, ada, http.MethodGet, srv.URL+"/api/assistant/sessions/"+created.Session.ID, nil)
	assert.Equal(t, http.StatusOK, st, "the owner reads her own conversation")

	// Another user cannot — and is told "not found", not "forbidden": whether an
	// id exists is itself something about another account.
	st, _ = doReq(t, mert, http.MethodGet, srv.URL+"/api/assistant/sessions/"+created.Session.ID, nil)
	assert.Equal(t, http.StatusNotFound, st, "another user cannot read it")
	st, _ = doReq(t, mert, http.MethodDelete, srv.URL+"/api/assistant/sessions/"+created.Session.ID, nil)
	assert.Equal(t, http.StatusNotFound, st, "nor delete it")
	st, _ = doReq(t, mert, http.MethodPatch, srv.URL+"/api/assistant/sessions/"+created.Session.ID,
		map[string]any{"title": "mine now"})
	assert.Equal(t, http.StatusNotFound, st, "nor rename it")

	// And neither can the ADMIN through the message route. This is the line the
	// whole split schema is for.
	st, _ = doReq(t, adminClient, http.MethodGet, srv.URL+"/api/assistant/sessions/"+created.Session.ID, nil)
	assert.Equal(t, http.StatusNotFound, st, "an administrator has no path to another account's conversation")

	// What the admin CAN see: that it exists, whose it is, and how big it is.
	st, raw = doReq(t, adminClient, http.MethodGet, srv.URL+"/api/admin/assistant/sessions", nil)
	require.Equal(t, http.StatusOK, st, "admin list: %s", raw)
	var overview struct {
		Sessions []map[string]any `json:"sessions"`
	}
	require.NoError(t, json.Unmarshal(raw, &overview))
	require.NotEmpty(t, overview.Sessions)
	row := overview.Sessions[0]
	assert.Equal(t, "ada@test.local", row["user_email"])
	assert.Contains(t, row, "message_count")
	for _, forbidden := range []string{"messages", "content", "body"} {
		assert.NotContains(t, row, forbidden, "the operator's view carries no conversation")
	}

	// And that they can clear it.
	st, _ = doReq(t, adminClient, http.MethodDelete, srv.URL+"/api/admin/assistant/sessions/"+created.Session.ID, nil)
	assert.Equal(t, http.StatusOK, st)
	st, _ = doReq(t, ada, http.MethodGet, srv.URL+"/api/assistant/sessions/"+created.Session.ID, nil)
	assert.Equal(t, http.StatusNotFound, st, "and it is really gone")
}

func TestAssistantSessionListStaysWithinTheCap(t *testing.T) {
	srv, adminClient, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, adminClient, email, pw)
	createUser(t, srv.URL, adminClient, "lee@test.local", "LeePass1!", model.RoleUser)
	lee := freshClient(t)
	testutil.LoginAs(t, srv, lee, "lee@test.local", "LeePass1!")

	// Two past the cap; creating never fails, the oldest by activity simply go.
	for i := 0; i < model.MaxAssistantSessions+2; i++ {
		st, raw := doReq(t, lee, http.MethodPost, srv.URL+"/api/assistant/sessions", map[string]any{})
		require.Equal(t, http.StatusOK, st, "create %d: %s", i, raw)
	}
	st, raw := doReq(t, lee, http.MethodGet, srv.URL+"/api/assistant/sessions", nil)
	require.Equal(t, http.StatusOK, st)
	var list struct {
		Sessions []map[string]any `json:"sessions"`
		Max      int              `json:"max"`
	}
	require.NoError(t, json.Unmarshal(raw, &list))
	assert.Equal(t, model.MaxAssistantSessions, list.Max)
	assert.Len(t, list.Sessions, model.MaxAssistantSessions, "history is capped, and reaching the cap does not refuse a new conversation")
}
