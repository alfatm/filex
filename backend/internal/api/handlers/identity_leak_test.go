package handlers_test

// Other people's e-mail addresses, handed out as a display name.
//
// Three surfaces named an account by its address whenever it had set no display
// name: the authors of a file's revisions, the actors in a folder's activity
// feed, and the owner column of every listing. None of them is an operator
// screen — they are drawn for anybody holding VIEWER on the file — so the
// fallback published the addresses of everyone who had ever touched it.
//
// The rule is the one "shared with me" already applies to the granter: the
// display name only, and an account that has set none comes back with an id and
// no name, which the client says in the reader's own language.
//
// Each test is written from a SECOND account's side, because the leak is only a
// leak when the reader is not the person whose address it is.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/notify"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestVersionsList_NamesAnAuthorWithoutHandingOutTheirEmail(t *testing.T) {
	f := newVersionACLFixture(t)
	ctx := context.Background()

	// The stranger is given a grant too: this is about what a legitimate READER
	// of the file learns about the person who wrote it, not about the ACL.
	_, err := f.store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: f.node.StorageID, UserID: f.stranger.ID, PathPrefix: "Docs", Level: "editor",
	})
	require.NoError(t, err)

	// A revision authored by the owner, who has set no display name.
	snap := f.call(t, f.owner, f.handler.Snapshot, http.MethodPost, "/versions/snapshot",
		map[string]any{"node_id": f.node.ID})
	require.Equal(t, http.StatusOK, snap.Code, snap.Body.String())

	list := f.call(t, f.stranger, f.handler.List, http.MethodGet,
		fmt.Sprintf("/versions?node_id=%d", f.node.ID), nil)
	require.Equal(t, http.StatusOK, list.Code)
	assert.NotContains(t, list.Body.String(), f.owner.Email,
		"a colleague's address is not what an unnamed account is called")

	var body struct {
		Versions []struct {
			CreatedBy  *int64 `json:"created_by"`
			AuthorName string `json:"author_name"`
		} `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(list.Body.Bytes(), &body))
	var authored int
	for _, v := range body.Versions {
		if v.CreatedBy != nil && *v.CreatedBy == f.owner.ID {
			authored++
			assert.Empty(t, v.AuthorName, "no display name means no name, not an address")
		}
	}
	require.Positive(t, authored, "the revision the assertion is about has to exist")

	// And a name that WAS set is still printed, or this would be a fix that
	// simply stopped naming anybody.
	require.NoError(t, f.store.UpdateUserDisplayName(ctx, f.owner.ID, "Sahip Bey"))
	named := f.call(t, f.stranger, f.handler.List, http.MethodGet,
		fmt.Sprintf("/versions?node_id=%d", f.node.ID), nil)
	require.Equal(t, http.StatusOK, named.Code)
	assert.Contains(t, named.Body.String(), "Sahip Bey")
	assert.NotContains(t, named.Body.String(), f.owner.Email)
}

func TestActivity_NamesAnActorWithoutHandingOutTheirEmail(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()

	user, err := f.store.CreateUser(ctx, "adsiz@filex.test", "x", "user", "tr", "UTC")
	require.NoError(t, err)
	svc := notify.New(f.store, notify.Config{})
	_, err = svc.Send(ctx, notify.Event{
		Event: notify.EventFileUploaded, Severity: notify.SeverityInfo, Title: "uploaded",
		Node: &notify.NodeRef{StorageID: f.st.ID, Path: "/Docs/notes.md", Name: "notes.md"},
		// The address travels INTO the row — that is the bell's own payload —
		// and the feed used to read it straight back out.
		Actor: &notify.ActorRef{ID: user.ID, Email: user.Email},
	})
	require.NoError(t, err)

	events := f.events(t, "main://Docs/notes.md")
	require.Len(t, events, 1)
	assert.EqualValues(t, user.ID, events[0]["actor_id"], "the id still says who it was")
	assert.NotContains(t, events[0], "actor_name", "an unnamed account is unnamed, not an address")

	raw, err := json.Marshal(events)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), user.Email)

	require.NoError(t, f.store.UpdateUserDisplayName(ctx, user.ID, "Adsız Kullanıcı"))
	events = f.events(t, "main://Docs/notes.md")
	require.Len(t, events, 1)
	assert.Equal(t, "Adsız Kullanıcı", events[0]["actor_name"], "a name that was set is still printed")
}

// The owner column of every listing, and the operator screens that legitimately
// carry an address — which reach it by a different route and are unaffected.
func TestNodeOwners_NameAnOwnerWithoutHandingOutTheirEmail(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	owner, err := store.CreateUser(ctx, "sahip@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	node, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "rapor.md", Path: "/rapor.md",
		PathHash: "h-rapor", StorageKey: "/rapor.md", Type: model.NodeTypeFile,
	})
	require.NoError(t, err)
	require.NoError(t, store.SetNodeOwner(ctx, node.ID, &owner.ID))

	owners, err := store.NodeOwners(ctx, []int64{node.ID})
	require.NoError(t, err)
	require.Len(t, owners, 1)
	assert.EqualValues(t, owner.ID, owners[0].OwnerID, "the id still says whose it is")
	assert.Empty(t, owners[0].Name, "an owner column is drawn for everybody who can see the listing")

	require.NoError(t, store.UpdateUserDisplayName(ctx, owner.ID, "Sahip Bey"))
	owners, err = store.NodeOwners(ctx, []int64{node.ID})
	require.NoError(t, err)
	require.Len(t, owners, 1)
	assert.Equal(t, "Sahip Bey", owners[0].Name)

	// ⚠ The operator's own screens are a different question and a different
	// route: /api/admin/users answers with the account row itself, and nothing
	// above touches it.
	users, err := store.ListUsers(ctx)
	require.NoError(t, err)
	var found bool
	for _, u := range users {
		if u.ID == owner.ID {
			found = true
			assert.Equal(t, "sahip@filex.test", u.Email,
				"an administrator still gets the address, from the route that is meant to carry it")
		}
	}
	require.True(t, found)
}

// The fourth surface of the same family: a comment thread names its authors,
// and both drivers fell back to the address for an account that had set no
// display name. A thread is readable by everybody who may open the file, so
// that published the e-mail of every colleague who had written on it.
func TestNodeComments_NameAnAuthorWithoutHandingOutTheirEmail(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	author, err := store.CreateUser(ctx, "yazar@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	node, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "rapor.md", Path: "/rapor.md",
		PathHash: "h-yorum", StorageKey: "/rapor.md", Type: model.NodeTypeFile,
	})
	require.NoError(t, err)

	created, err := store.CreateNodeComment(ctx, &model.NodeComment{
		NodeID: node.ID, UserID: author.ID, Body: "ilk yorum",
	})
	require.NoError(t, err)
	assert.Empty(t, created.AuthorName, "no display name means no name, not an address")

	list, err := store.ListNodeComments(ctx, node.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.EqualValues(t, author.ID, list[0].UserID, "the id still says who wrote it")
	assert.Empty(t, list[0].AuthorName)

	raw, err := json.Marshal(list)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), author.Email,
		"a colleague's address is not what an unnamed account is called")

	// A name that WAS set is still printed, or this would be a fix that simply
	// stopped naming anybody.
	require.NoError(t, store.UpdateUserDisplayName(ctx, author.ID, "Yazar Bey"))
	list, err = store.ListNodeComments(ctx, node.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, "Yazar Bey", list[0].AuthorName)

	one, err := store.GetNodeComment(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, "Yazar Bey", one.AuthorName, "the single-comment read agrees with the list")

	// ⚠ The operator's own screen is a different question and a different
	// route: /api/admin/users answers with the account row itself, and nothing
	// above touches it.
	users, err := store.ListUsers(ctx)
	require.NoError(t, err)
	var found bool
	for _, u := range users {
		if u.ID == author.ID {
			found = true
			assert.Equal(t, "yazar@filex.test", u.Email,
				"an administrator still gets the address, from the route that is meant to carry it")
		}
	}
	require.True(t, found)
}
