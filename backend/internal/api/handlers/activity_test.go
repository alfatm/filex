package handlers_test

// The per-node activity feed. filex has recorded every file event since
// notifications existed, but only as a bell entry scoped to whoever acted, with
// the file inside meta_json — so "what happened to THIS file" could not be asked
// and the app's Activity panel was empty against a live server.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/notify"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type activityFixture struct {
	store db.Store
	h     *handlers.Activity
	st    *model.Storage
}

func newActivityFixture(t *testing.T) *activityFixture {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	return &activityFixture{store: store, h: handlers.NewActivity(store), st: st}
}

func (f *activityFixture) events(t *testing.T, path string) []map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	f.h.List(rec, httptest.NewRequest(http.MethodGet, "/api/files/activity?path="+path, nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Events []map[string]any `json:"events"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body.Events
}

func TestActivity_ListsOnlyWhatHappenedToThatFile(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()

	user, err := f.store.CreateUser(ctx, "ayse@filex.test", "x", "user", "tr", "UTC")
	require.NoError(t, err)
	require.NoError(t, f.store.UpdateUserDisplayName(ctx, user.ID, "Ayşe"))
	svc := notify.New(f.store, notify.Config{})

	// Two events on the file we ask about, one on its neighbour.
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventFileUploaded, Severity: notify.SeverityInfo, Title: "uploaded",
		Node:  &notify.NodeRef{StorageID: f.st.ID, Path: "/Docs/notes.md", Name: "notes.md"},
		Actor: &notify.ActorRef{ID: user.ID, Email: user.Email},
	})
	require.NoError(t, err)
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventFileMoved, Severity: notify.SeverityInfo, Title: "moved",
		Meta:  map[string]any{"from": "/notes.md", "to": "/Docs/notes.md"},
		Node:  &notify.NodeRef{StorageID: f.st.ID, Path: "/Docs/notes.md", Name: "notes.md"},
		Actor: &notify.ActorRef{ID: user.ID, Email: user.Email},
	})
	require.NoError(t, err)
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventFileUploaded, Severity: notify.SeverityInfo, Title: "uploaded",
		Node: &notify.NodeRef{StorageID: f.st.ID, Path: "/Docs/other.md", Name: "other.md"},
	})
	require.NoError(t, err)

	got := f.events(t, "main://Docs/notes.md")
	require.Len(t, got, 2, "the neighbour's event belongs to the neighbour")
	// Newest first: the move was recorded after the upload.
	require.Equal(t, "file.moved", got[0]["event"])
	require.Equal(t, "file.uploaded", got[1]["event"])

	// The actor is named from the users table, not left as a bare id.
	require.Equal(t, "Ayşe", got[0]["actor_name"])
	require.EqualValues(t, user.ID, got[0]["actor_id"])

	// The event's own payload rides along — it is what tells a rename from a
	// move — while `actor` and `node` are lifted into fields of their own.
	meta, ok := got[0]["meta"].(map[string]any)
	require.True(t, ok, "a move carries its from/to")
	require.Equal(t, "/notes.md", meta["from"])
	require.NotContains(t, meta, "actor")
	require.NotContains(t, meta, "node")
}

func TestActivity_AFileNothingHasHappenedToAnswersAnEmptyFeed(t *testing.T) {
	f := newActivityFixture(t)
	require.Empty(t, f.events(t, "main://Docs/quiet.md"))
}

func TestActivity_RefusesAPathItCannotAddress(t *testing.T) {
	f := newActivityFixture(t)
	for _, path := range []string{"", "notes.md", "yok://a.txt"} {
		rec := httptest.NewRecorder()
		f.h.List(rec, httptest.NewRequest(http.MethodGet, "/api/files/activity?path="+path, nil))
		require.Equal(t, http.StatusBadRequest, rec.Code, "path %q", path)
	}
}

// meta_json is the bell payload, and the bell payload of a `share.created`
// carries the share's token (notify.ShareRef). The feed used to copy every key
// it did not explicitly strip, so any account with ≥viewer on a file read the
// credential for its public link straight out of the Activity tab — and for a
// `kind=drop` link that is a viewer who can now upload anonymously. The feed is
// keyed by path, so the tokens outlived the file: delete it, recreate the same
// name, and the new file's viewers inherit the old one's links.
func TestActivity_NeverHandsOutAShareToken(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	svc := notify.New(f.store, notify.Config{})

	_, err := svc.Send(ctx, notify.Event{
		Event: notify.EventShareCreated, Severity: notify.SeverityInfo, Title: "shared",
		Meta:  map[string]any{"kind": "drop", "has_pin": true, "origin": "manager"},
		Node:  &notify.NodeRef{StorageID: f.st.ID, Path: "/Docs/notes.md", Name: "notes.md"},
		Share: &notify.ShareRef{Token: "s3cr3t-token", Path: "/Docs/notes.md"},
	})
	require.NoError(t, err)

	rec := httptest.NewRecorder()
	f.h.List(rec, httptest.NewRequest(http.MethodGet, "/api/files/activity?path=main://Docs/notes.md", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// Checked against the raw body, not only the parsed meta: the token must not
	// reach the client under any key, however the payload is nested.
	require.NotContains(t, rec.Body.String(), "s3cr3t-token")

	got := f.events(t, "main://Docs/notes.md")
	require.Len(t, got, 1)
	require.Equal(t, "share.created", got[0]["event"])
	meta, _ := got[0]["meta"].(map[string]any)
	require.NotContains(t, meta, "share")
	require.NotContains(t, meta, "has_pin", "the UI never shows it and it describes the link's protection")
	// The whitelist is a whitelist and not a hole: what the feed does render
	// still comes through.
	require.Equal(t, "manager", meta["origin"])
}

func TestActivity_KeepsTheFieldsTheFeedActuallyRenders(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	svc := notify.New(f.store, notify.Config{})

	_, err := svc.Send(ctx, notify.Event{
		Event: notify.EventFileTrashed, Severity: notify.SeverityInfo, Title: "trashed",
		Meta: map[string]any{"origin": "manager", "trash_path": ".filex-trash/1700000000__gizli.md"},
		Node: &notify.NodeRef{StorageID: f.st.ID, Path: "/Docs/gizli.md", Name: "gizli.md"},
	})
	require.NoError(t, err)

	got := f.events(t, "main://Docs/gizli.md")
	require.Len(t, got, 1)
	meta, _ := got[0]["meta"].(map[string]any)
	require.Equal(t, "manager", meta["origin"])
	require.NotContains(t, meta, "trash_path", "the internal trash key is not something a details panel shows")
}
