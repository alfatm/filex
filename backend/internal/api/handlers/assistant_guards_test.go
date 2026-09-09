package handlers_test

// The guards in front of the assistant's endpoints, as opposed to the guards
// inside them: what a request body may weigh, how much work a single tool call
// may ask for before a person has approved anything, and the difference between
// "there is no such conversation" and "the database would not say".

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// A plan longer than its kind may carry is refused BEFORE the paths are
// resolved.
//
// Resolving one path is a drive listing, a grants read and a node lookup, and
// the ceiling used to be checked only once every one of them had run — so a
// model, or an injection in a file it had been allowed to read, could name a
// thousand paths and spend a thousand round trips on a plan that was never
// going to be storable, with nobody having approved anything.
//
// The two assertions are what separates the two orders: the refusal names the
// ceiling. On the old code every path resolved to nothing, the items were
// dropped as unresolved, and what came back was "the plan came out empty".
func TestAssistantPlan_TooManyPathsAreRefusedBeforeTheyAreResolved(t *testing.T) {
	paths := make([]string, model.MaxPlanTagItems+1)
	for i := range paths {
		paths[i] = fmt.Sprintf("main://notes/absent-%d.txt", i)
	}
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": paths, "tags": []string{"arşiv"}, "summary": "Tag everything",
		}),
		textFrame("That is more files than one plan can carry."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag everything")
	assert.Empty(t, eventsOfType(events, "card"), "nothing was proposed to the person")

	sent := provider.sent()
	assert.Contains(t, sent, fmt.Sprintf("at most %d items", model.MaxPlanTagItems),
		"the model is told about the ceiling, so it can propose a narrower plan")
	assert.NotContains(t, sent, "the plan came out empty",
		"reaching that message means every path was resolved first")
}

// The bodies that used to be read without a ceiling. A megabyte of JSON on a
// rename is not a rename.
func TestAssistantSession_RequestBodiesAreBounded(t *testing.T) {
	srv, adminClient, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, adminClient, email, pw)

	session := newSession(t, srv, adminClient)
	huge := strings.Repeat("a", 64*1024)

	st, _ := doReq(t, adminClient, http.MethodPatch, srv.URL+"/api/assistant/sessions/"+session,
		map[string]any{"title": huge})
	assert.Equal(t, http.StatusBadRequest, st, "a rename past the ceiling is refused, not truncated")

	st, _ = doReq(t, adminClient, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/approvals",
		map[string]any{"path": huge, "decision": "allow"})
	assert.Equal(t, http.StatusBadRequest, st, "so is an approval body past the ceiling")

	st, _ = doReq(t, adminClient, http.MethodPost, srv.URL+"/api/assistant/sessions",
		map[string]any{"title": huge})
	assert.Equal(t, http.StatusBadRequest, st, "and a conversation is not started from one")
}

// Creating a conversation used to ignore the decode error outright, so any
// rubbish on the wire produced a conversation named "New chat" and a 200.
func TestAssistantSession_CreateRefusesABodyItCannotRead(t *testing.T) {
	srv, adminClient, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, adminClient, email, pw)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/assistant/sessions", strings.NewReader("{not json"))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := adminClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "a body that cannot be read is not a conversation")

	// And nothing was written: the refusal has to be a refusal in the store too.
	st, raw := doReq(t, adminClient, http.MethodGet, srv.URL+"/api/assistant/sessions", nil)
	require.Equal(t, http.StatusOK, st, "list: %s", raw)
	assert.Contains(t, string(raw), `"sessions":[]`)

	// An ABSENT body still starts one — that is how the panel opens an unnamed
	// conversation, and the fix must not take it away.
	st, _ = doReq(t, adminClient, http.MethodPost, srv.URL+"/api/assistant/sessions", nil)
	assert.Equal(t, http.StatusOK, st)
}

// brokenSessionStore fails the one read the ownership check makes, the way a
// database in trouble fails it: no row, and a reason that is not "no row".
type brokenSessionStore struct {
	db.Store
	err error
}

func (s brokenSessionStore) GetAssistantSession(context.Context, int64) (*model.AssistantSession, error) {
	return nil, s.err
}

// withSession puts the route parameter and the principal on a request, so the
// handler can be called without a router in front of it.
func withSession(req *http.Request, id string, user *model.User) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	return req.WithContext(auth.WithUser(ctx, user))
}

// A database that will not answer is a 500. It used to be a 404, which meant
// monitoring saw no failure at all and the person was told their conversation
// did not exist.
func TestAssistantSession_DatabaseFailureIsNotNotFound(t *testing.T) {
	store := brokenSessionStore{err: errors.New("database is locked")}
	h := handlers.NewAssistant(store)
	user := &model.User{ID: 7, Email: "ada@test.local", Role: model.RoleUser}

	for _, tc := range []struct {
		name string
		run  func(http.ResponseWriter, *http.Request)
	}{
		{"messages", h.Messages},
		{"rename", h.RenameSession},
		{"delete", h.DeleteSession},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := withSession(httptest.NewRequest(http.MethodGet, "/api/assistant/sessions/3", strings.NewReader(`{"title":"x"}`)), "3", user)
			rec := httptest.NewRecorder()
			tc.run(rec, req)
			assert.Equal(t, http.StatusInternalServerError, rec.Code)
			assert.Contains(t, rec.Body.String(), "database is locked",
				"the failure is reported as itself, not disguised as a missing row")
		})
	}
}

// The operator's delete, same distinction. The 404 half has to keep working:
// this is the branch the fix could plausibly have broken.
func TestAssistantAdmin_DeleteSeparatesAMissingRowFromABrokenDatabase(t *testing.T) {
	srv, adminClient, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, adminClient, email, pw)

	st, raw := doReq(t, adminClient, http.MethodDelete, srv.URL+"/api/admin/assistant/sessions/999999", nil)
	assert.Equal(t, http.StatusNotFound, st, "an id that is not there is still a 404: %s", raw)

	broken := handlers.NewAssistantAdmin(brokenSessionStore{err: errors.New("database is locked")})
	req := withSession(httptest.NewRequest(http.MethodDelete, "/api/admin/assistant/sessions/3", nil), "3", &model.User{ID: 1, Role: model.RoleAdmin})
	rec := httptest.NewRecorder()
	broken.DeleteSession(rec, req)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Contains(t, rec.Body.String(), "database is locked")
}
