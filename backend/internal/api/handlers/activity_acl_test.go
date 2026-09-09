package handlers_test

// The per-file activity feed, from the side of an account that was not given
// the file.
//
// The feed names everyone who has ever written to a file and when. It is
// therefore exactly as readable as the file itself, and a caller without a
// grant is refused rather than handed an empty list — an empty list is itself
// an answer about whether that path is a file anything has happened to.
//
// The suite around this handler built it with `handlers.NewActivity(store)` and
// never attached a resolver, so the ≥viewer rule held on the source alone.

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
	"github.com/brf-tech/filex/backend/internal/notify"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type activityACLFixture struct {
	store   db.Store
	handler *handlers.Activity
	// reader holds viewer on `Ekip`; stranger holds nothing. Neither is an
	// admin: an admin is Owner everywhere and would prove nothing about the
	// gate.
	reader, stranger *model.User
}

func newActivityACLFixture(t *testing.T) *activityACLFixture {
	t.Helper()
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)

	svc := notify.New(store, notify.Config{})
	actor, err := store.CreateUser(ctx, "ayse@filex.test", "x", model.RoleUser, "tr", "UTC")
	require.NoError(t, err)
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventFileUploaded, Severity: notify.SeverityInfo, Title: "uploaded",
		Meta:  map[string]any{"origin": "manager"},
		Node:  &notify.NodeRef{StorageID: st.ID, Path: "/Ekip/notlar.md", Name: "notlar.md"},
		Actor: &notify.ActorRef{ID: actor.ID, Email: actor.Email},
	})
	require.NoError(t, err)
	// A link on the same file, so the feed a permitted caller reads is the one
	// carrying a credential in its bell payload.
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventShareCreated, Severity: notify.SeverityInfo, Title: "shared",
		Meta:  map[string]any{"origin": "manager"},
		Node:  &notify.NodeRef{StorageID: st.ID, Path: "/Ekip/notlar.md", Name: "notlar.md"},
		Share: &notify.ShareRef{Token: "s3cr3t-token", Path: "/Ekip/notlar.md"},
	})
	require.NoError(t, err)
	// And one on a file nobody here was granted.
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventFileUploaded, Severity: notify.SeverityInfo, Title: "uploaded",
		Node: &notify.NodeRef{StorageID: st.ID, Path: "/Baskasi/plan.md", Name: "plan.md"},
	})
	require.NoError(t, err)

	f := &activityACLFixture{store: store}
	f.handler = handlers.NewActivity(store)
	f.handler.AttachACL(acl.New(store))
	f.reader = testutil.SeedUser(t, store, "okuyucu@filex.test", "TestUserPass!1")
	f.stranger = testutil.SeedUser(t, store, "yabanci@filex.test", "TestUserPass!1")
	testutil.GrantPath(t, store, st.ID, f.reader.ID, "Ekip", model.GrantViewer)
	return f
}

func (f *activityACLFixture) list(t *testing.T, as *model.User, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/files/activity?path="+path, nil)
	rec := httptest.NewRecorder()
	f.handler.List(rec, req.WithContext(auth.WithUser(req.Context(), as)))
	return rec
}

func TestActivity_RefusesAnAccountThatCannotSeeTheFile(t *testing.T) {
	f := newActivityACLFixture(t)

	denied := f.list(t, f.stranger, "main://Ekip/notlar.md")
	assert.Equal(t, http.StatusForbidden, denied.Code,
		"403, not an empty feed: an empty feed is an answer about whether that path is a file")
	assert.NotContains(t, denied.Body.String(), "ayse@filex.test",
		"and it names nobody — the feed's whole content is who touched the file")

	// The grant holder still reads it, and the grant reaches the file through
	// the folder it is in.
	allowed := f.list(t, f.reader, "main://Ekip/notlar.md")
	require.Equal(t, http.StatusOK, allowed.Code, allowed.Body.String())
	var body struct {
		Events []map[string]any `json:"events"`
	}
	require.NoError(t, json.Unmarshal(allowed.Body.Bytes(), &body))
	require.Len(t, body.Events, 2)
	assert.Equal(t, "share.created", body.Events[0]["event"])
	assert.Equal(t, "file.uploaded", body.Events[1]["event"])

	// A grant is not a way past the whitelist: the share token stays out of the
	// feed at every level of permission, not merely for callers who are refused.
	assert.NotContains(t, allowed.Body.String(), "s3cr3t-token")
}

// The grant is on `Ekip`, and it stops there.
func TestActivity_AGrantIsNotAGrantOnTheRestOfTheDrive(t *testing.T) {
	f := newActivityACLFixture(t)

	rec := f.list(t, f.reader, "main://Baskasi/plan.md")
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	// Nor does a path nothing has happened to leak the difference between "no
	// events" and "not yours".
	quiet := f.list(t, f.reader, "main://Baskasi/sessiz.md")
	assert.Equal(t, http.StatusForbidden, quiet.Code)
}
