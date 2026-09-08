package handlers_test

// The changing half of the assistant, tested where it can actually be wrong:
// nothing happens until the person approves, what happens is what the STORED
// plan says (not what the model asks for afterwards), and a file that moved
// under the plan is left alone.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
)

// planCard pulls the one plan card out of a turn's events.
func planCard(t *testing.T, events []map[string]any) map[string]any {
	t.Helper()
	cards := eventsOfType(events, "card")
	require.Len(t, cards, 1, "expected exactly one card, got %v", cards)
	require.Equal(t, "plan", cards[0]["kind"])
	return cards[0]
}

func TestAssistantPlan_TagsOnlyHappenAfterTheApproval(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "tags": []string{"sprint", "notes"},
			"summary": "Tag the notes file",
		}),
		textFrame("I have proposed tagging it."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag the notes file")
	card := planCard(t, events)
	assert.Equal(t, "Tag the notes file", card["summary"])
	assert.Equal(t, model.PlanPending, card["status"])
	items, _ := card["items"].([]any)
	require.Len(t, items, 1)
	first, _ := items[0].(map[string]any)
	assert.Equal(t, "main://notes/hello.txt", first["path"])
	assert.Equal(t, "tag", first["action"], "a code, not a sentence: the panel says it in the reader's language")
	assert.Equal(t, map[string]any{"tags": "sprint, notes"}, first["args"])

	// ⚠ Nothing has been tagged yet. The model asked; the person has not answered.
	node := nodeAt(t, store, "main://notes/hello.txt")
	tags, err := store.GetNodeTags(context.Background(), node.ID)
	require.NoError(t, err)
	assert.Empty(t, tags, "a proposed plan changes nothing")

	planID, _ := card["plan_id"].(string)
	require.NotEmpty(t, planID)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var outcome struct {
		Done    int `json:"done"`
		Skipped int `json:"skipped"`
		Failed  int `json:"failed"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Equal(t, 1, outcome.Done)

	tags, err = store.GetNodeTags(context.Background(), node.ID)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"sprint", "notes"}, tags)

	// Approving twice runs the work once.
	st, _ = doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	assert.Equal(t, http.StatusConflict, st)
}

// ⚠⚠ The fingerprint. The person approved the file they were shown; if it
// changed in between, the item is skipped rather than applied to something else.
func TestAssistantPlan_SkipsAFileThatChangedAfterTheProposal(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "tags": []string{"sprint"}, "summary": "Tag it",
		}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag it")
	planID, _ := planCard(t, events)["plan_id"].(string)

	// Somebody else edits the file between the proposal and the approval.
	node := nodeAt(t, store, "main://notes/hello.txt")
	require.NoError(t, store.UpdateNodeMeta(context.Background(), node.ID, node.Size+10, node.Mime, "another-etag", node.DBMtime))

	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st)
	var outcome struct {
		Done    int `json:"done"`
		Skipped int `json:"skipped"`
		Items   []struct {
			State  string `json:"state"`
			Reason string `json:"reason"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Equal(t, 0, outcome.Done)
	assert.Equal(t, 1, outcome.Skipped)
	assert.Contains(t, outcome.Items[0].Reason, "changed after the plan was made")

	tags, err := store.GetNodeTags(context.Background(), node.ID)
	require.NoError(t, err)
	assert.Empty(t, tags)
}

// A refused plan runs never, and says so when it is asked to.
func TestAssistantPlan_CancelledPlanCannotBeRunLater(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "tags": []string{"sprint"}, "summary": "Tag it",
		}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag it")
	planID, _ := planCard(t, events)["plan_id"].(string)

	st, _ := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/cancel", map[string]any{})
	require.Equal(t, http.StatusOK, st)
	st, _ = doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	assert.Equal(t, http.StatusConflict, st, "a refused plan is decided, and a decided plan does not run")

	node := nodeAt(t, store, "main://notes/hello.txt")
	tags, _ := store.GetNodeTags(context.Background(), node.ID)
	assert.Empty(t, tags)

	// Reopening the conversation shows it as refused rather than as a pending
	// question with a live button.
	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Messages []struct {
			Cards []map[string]any `json:"cards"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	var seen int
	for _, m := range stored.Messages {
		for _, card := range m.Cards {
			if card["kind"] == "plan" {
				seen++
				assert.Equal(t, model.PlanCancelled, card["status"])
			}
		}
	}
	assert.Equal(t, 1, seen)
}

// The emptying plan names every item it would destroy, and destroys nothing
// until it is approved.
func TestAssistantPlan_EmptyTrashNamesWhatItWouldDestroy(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_empty_trash", map[string]any{"summary": "Empty the trash"}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantFiles(t, provider)

	// One file already in the trash. Put there through the store rather than
	// through the ops queue, which this fixture runs no worker for — what is
	// under test is what happens to a trashed row, not how it got trashed.
	node := nodeAt(t, store, "main://notes/pay.csv")
	require.NoError(t, store.SoftDeleteNode(context.Background(), node.ID))

	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "empty the trash")
	card := planCard(t, events)
	items, _ := card["items"].([]any)
	require.Len(t, items, 1, "the plan lists what would be destroyed, one line each")
	first, _ := items[0].(map[string]any)
	assert.Equal(t, "purge", first["action"])
	assert.NotZero(t, first["at"], "the item carries when it was deleted, for the panel to format")
	assert.Contains(t, fmt.Sprint(first["path"]), "pay.csv")

	// Still there: the plan is a proposal.
	n, err := store.GetNode(context.Background(), node.ID)
	require.NoError(t, err)
	require.NotNil(t, n)

	planID, _ := card["plan_id"].(string)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	_, err = store.GetNode(context.Background(), node.ID)
	assert.Error(t, err, "approved, so the trashed file is gone for good")
}

// A plan belonging to somebody else's conversation is not found, not forbidden.
func TestAssistantPlan_IsScopedToItsConversation(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "tags": []string{"sprint"}, "summary": "Tag it",
		}),
		textFrame("Proposed."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag it")
	planID, _ := planCard(t, events)["plan_id"].(string)

	other := newSession(t, srv, client)
	st, _ := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+other+"/plans/"+planID+"/approve", map[string]any{})
	assert.Equal(t, http.StatusNotFound, st)
}

// nodeAt is the cached node row for an address.
func nodeAt(t *testing.T, store db.Store, address string) *model.Node {
	t.Helper()
	storages, err := store.ListEnabledStorages(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, storages)
	rel := address[len(storages[0].Name+"://"):]
	node, err := store.GetNodeByPath(context.Background(), storages[0].ID, pathkey.Hash(storages[0].ID, rel))
	require.NoError(t, err, "no node row for %s — index the folder first", address)
	require.NotNil(t, node)
	return node
}
