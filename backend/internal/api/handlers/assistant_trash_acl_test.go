package handlers_test

// The trash the assistant may look at is the PERSON'S trash.
//
// trash.Service.List is the administrator's listing: it takes no account and
// filters nothing. Both trash tools called it and handed the result straight
// on — so `list_trash` told the model (and the model's provider) the paths,
// names and sizes of other people's deleted files, and `plan_empty_trash` put
// them on a card headed "these will be destroyed for good". The same listing
// also fed the 50-item ceiling, so somebody with three deleted files of their
// own was refused for being over a limit they were nowhere near.
//
// Every test here is written from the second account's side: an ordinary user
// holding one grant, who must see exactly what that grant covers.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// assistantTrashACL puts two deleted files in the trash — one under `notes`,
// one under `hr` — and returns a client logged in as an ordinary account that
// holds editor on `notes` and nothing at all on `hr`.
func assistantTrashACL(t *testing.T, provider *scriptedProvider) (*httptest.Server, *http.Client, db.Store) {
	t.Helper()
	srv, admin, store := assistantFiles(t, provider)
	ctx := context.Background()

	// RBAC on the drive: without it every account is owner everywhere and a
	// filter has nothing to filter.
	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, storages)
	st := storages[0]
	st.RBACEnabled = true
	require.NoError(t, store.UpdateStorage(ctx, st))

	// Somebody else's deleted file, on a branch of the drive this account
	// holds nothing on.
	const theirPath = "/hr/wages.csv"
	theirs, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "wages.csv", Path: theirPath,
		PathHash: pathkey.Hash(st.ID, theirPath), StorageKey: theirPath,
		Type: model.NodeTypeFile, Size: 4096,
	})
	require.NoError(t, err)
	require.NoError(t, store.SoftDeleteNode(ctx, theirs.ID))

	// And one of their own.
	mine := nodeAt(t, store, "main://notes/pay.csv")
	require.NoError(t, store.SoftDeleteNode(ctx, mine.ID))

	// Not an admin: an admin is owner everywhere by definition and would prove
	// nothing about the gate.
	const email, pw = "okuyucu@filex.test", "TestUserPass!1"
	userID := createUser(t, srv.URL, admin, email, pw, model.RoleUser)
	_, err = store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: st.ID, UserID: userID, PathPrefix: "notes", Level: "editor",
	})
	require.NoError(t, err)

	client := freshClient(t)
	testutil.LoginAs(t, srv, client, email, pw)
	return srv, client, store
}

func TestAssistantTools_ListTrashShowsOnlyWhatTheAccountMaySee(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "list_trash", map[string]any{}),
		textFrame("There is one thing in your trash."),
	)
	srv, client, _ := assistantTrashACL(t, provider)
	session := newSession(t, srv, client)

	turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "what is in my trash?")

	// Asserted on what filex SENT THE PROVIDER, which is the only place the
	// leak was real: a tool result travels to the model, and from there off
	// this installation entirely.
	sent := provider.sent()
	assert.Contains(t, sent, "pay.csv", "their own deleted file is theirs to see")
	assert.NotContains(t, sent, "wages.csv",
		"somebody else's deleted file must not reach the model, let alone its provider")
	assert.NotContains(t, sent, "hr/", "nor the folder it was deleted from")
}

func TestAssistantPlan_EmptyTrashNamesOnlyWhatTheAccountMaySee(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_empty_trash", map[string]any{"summary": "Empty the trash"}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantTrashACL(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "empty my trash")
	card := planCard(t, events)
	items, _ := card["items"].([]any)
	require.Len(t, items, 1, "the card names what would be destroyed, and only that: %v", items)
	first, _ := items[0].(map[string]any)
	assert.Contains(t, fmt.Sprint(first["path"]), "pay.csv")
	assert.NotContains(t, provider.sent(), "wages.csv")

	// And approving it destroys only that one: the other account's file is
	// still in the trash, where it can still be restored.
	planID, _ := card["plan_id"].(string)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var outcome struct {
		Done int `json:"done"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Equal(t, 1, outcome.Done)

	storages, err := store.ListEnabledStorages(context.Background())
	require.NoError(t, err)
	theirs, err := store.GetNodeByPathIncludingDeleted(context.Background(), storages[0].ID, pathkey.Hash(storages[0].ID, "hr/wages.csv"))
	require.NoError(t, err, "the other account's file was never part of this plan")
	require.NotNil(t, theirs)
	assert.NotNil(t, theirs.DeletedAt, "and it is still in the trash, still restorable")
}

// The 50-item ceiling is counted over the person's OWN entries. Counted over
// the installation, an account with a handful of deleted files was told the
// trash held "more than 50 items" and refused a plan it could easily have run.
func TestAssistantPlan_EmptyTrashCeilingCountsOnlyTheirOwnEntries(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_empty_trash", map[string]any{"summary": "Empty the trash"}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantTrashACL(t, provider)
	ctx := context.Background()
	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)

	// Well past the ceiling, all of it on the branch this account cannot see.
	for i := range model.MaxPlanItems + 5 {
		rel := fmt.Sprintf("/hr/payslip-%d.pdf", i)
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: storages[0].ID, Name: fmt.Sprintf("payslip-%d.pdf", i), Path: rel,
			PathHash: pathkey.Hash(storages[0].ID, rel), StorageKey: rel,
			Type: model.NodeTypeFile, Size: 10,
		})
		require.NoError(t, cerr)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
	}

	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "empty my trash")
	card := planCard(t, events)
	items, _ := card["items"].([]any)
	assert.Len(t, items, 1, "one deleted file of their own is one item, whatever the rest of the installation deleted")
	assert.NotContains(t, provider.sent(), "more than 50 items")
}
