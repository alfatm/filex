package handlers_test

// "Active sessions" was the one row of the user settings modal with nothing behind it: filex has
// recorded every sign-in since migration 00001 — ip, user agent, when it was made, when it runs
// out — and offered no way for the person who made them to see or end one. The password change
// already revoked "every other session", so the account could act on the set blindly but never
// look at it.
//
// The two rules worth a test: the list is the CALLER's (no id is taken from the request), and the
// session the request itself rides on is refused rather than deleted.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	authlocal "github.com/brf-tech/filex/backend/internal/auth/drivers/local"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type sessionRow struct {
	ID        int64  `json:"id"`
	IP        string `json:"ip"`
	UserAgent string `json:"user_agent"`
	Current   bool   `json:"current"`
}

func sessionsFixture(t *testing.T) (db.Store, chi.Router, *model.User) {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	user, err := store.CreateUser(context.Background(), "self@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)

	h := handlers.NewAuthSelf(store)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithUser(req.Context(), user)))
		})
	})
	r.Get("/api/auth/sessions", h.Sessions)
	r.Delete("/api/auth/sessions/{id}", h.RevokeSession)
	return store, r, user
}

func TestSessionsListsOnlyTheCallersOwn(t *testing.T) {
	ctx := context.Background()
	store, router, user := sessionsFixture(t)

	other, err := store.CreateUser(ctx, "somebody@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	hour := time.Now().Add(time.Hour)
	here, err := store.CreateSession(ctx, user.ID, "token-here", hour, "10.0.0.1", "Firefox")
	require.NoError(t, err)
	elsewhere, err := store.CreateSession(ctx, user.ID, "token-elsewhere", hour, "10.0.0.2", "Safari")
	require.NoError(t, err)
	_, err = store.CreateSession(ctx, user.ID, "token-stale", time.Now().Add(-time.Hour), "10.0.0.3", "Chrome")
	require.NoError(t, err)
	theirs, err := store.CreateSession(ctx, other.ID, "token-theirs", hour, "10.0.0.4", "Edge")
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/api/auth/sessions", nil)
	req.AddCookie(&http.Cookie{Name: authlocal.SessionCookieName, Value: "token-here"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var got struct {
		Sessions []sessionRow `json:"sessions"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	// Two live ones: the expired row is gone and another account's session was never in scope.
	require.Len(t, got.Sessions, 2)
	byID := map[int64]sessionRow{}
	for _, s := range got.Sessions {
		byID[s.ID] = s
		require.NotEqual(t, theirs.ID, s.ID)
	}
	require.True(t, byID[here.ID].Current, "the session the request rides on is marked current")
	require.False(t, byID[elsewhere.ID].Current)
	require.Equal(t, "10.0.0.2", byID[elsewhere.ID].IP)
	require.Equal(t, "Safari", byID[elsewhere.ID].UserAgent)
	// The credential itself is never in the answer.
	require.NotContains(t, rec.Body.String(), "token-here")
}

func TestRevokeSessionEndsOthersAndRefusesTheCurrentOne(t *testing.T) {
	ctx := context.Background()
	store, router, user := sessionsFixture(t)

	other, err := store.CreateUser(ctx, "somebody@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	hour := time.Now().Add(time.Hour)
	here, err := store.CreateSession(ctx, user.ID, "token-here", hour, "10.0.0.1", "Firefox")
	require.NoError(t, err)
	elsewhere, err := store.CreateSession(ctx, user.ID, "token-elsewhere", hour, "10.0.0.2", "Safari")
	require.NoError(t, err)
	theirs, err := store.CreateSession(ctx, other.ID, "token-theirs", hour, "10.0.0.4", "Edge")
	require.NoError(t, err)

	revoke := func(id int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodDelete, "/api/auth/sessions/"+strconv.FormatInt(id, 10), nil)
		req.AddCookie(&http.Cookie{Name: authlocal.SessionCookieName, Value: "token-here"})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	require.Equal(t, http.StatusNoContent, revoke(elsewhere.ID).Code)
	_, err = store.GetSessionByToken(ctx, "token-elsewhere")
	require.Error(t, err, "the revoked session no longer authenticates anything")

	// The session this request is authenticated by is refused: ending it is signing out.
	rec := revoke(here.ID)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	_, err = store.GetSessionByToken(ctx, "token-here")
	require.NoError(t, err)

	// Somebody else's session id is not "forbidden", it is not there at all.
	require.Equal(t, http.StatusNotFound, revoke(theirs.ID).Code)
	_, err = store.GetSessionByToken(ctx, "token-theirs")
	require.NoError(t, err)
}
