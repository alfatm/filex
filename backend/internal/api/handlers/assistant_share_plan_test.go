package handlers_test

// Minting a public link is the only thing the assistant can propose that
// reaches OUTSIDE the installation: a /s/ URL opens without an account. So it
// goes the same way every other change goes — the model writes a plan, the
// person approves it, and the SERVER does the work — with two additions that
// only this kind needs.
//
// It has to hand the URL back. A link nobody was shown is a link nobody can
// use, so the result carries it and the panel prints it.
//
// And the fingerprint has to hold. Between proposing and approving, the file
// can be replaced; publishing a link to whatever now sits at that path, under
// an approval given for something else, is precisely the mistake the plan
// mechanism exists to prevent.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
)

// approvePlan runs the plan the card names and returns the decoded outcome.
func approvePlan(t *testing.T, client *http.Client, base, session, planID string) struct {
	Status  string           `json:"status"`
	Items   []map[string]any `json:"items"`
	Done    int              `json:"done"`
	Skipped int              `json:"skipped"`
	Failed  int              `json:"failed"`
} {
	t.Helper()
	var out struct {
		Status  string           `json:"status"`
		Items   []map[string]any `json:"items"`
		Done    int              `json:"done"`
		Skipped int              `json:"skipped"`
		Failed  int              `json:"failed"`
	}
	st, raw := doReq(t, client, http.MethodPost, base+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

func TestAssistantPlan_ShareLinkIsMintedOnlyOnApprovalAndHandedBack(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_create_share", map[string]any{
			"path": "main://notes/hello.txt", "summary": "Share the notes file by link",
		}),
		textFrame("I have proposed a public link."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "give me a link to the notes file")
	card := planCard(t, events)
	assert.Equal(t, model.PlanKindCreateShare, card["plan_kind"])
	assert.Equal(t, model.PlanPending, card["status"])
	items, _ := card["items"].([]any)
	require.Len(t, items, 1)
	first, _ := items[0].(map[string]any)
	assert.Equal(t, "create_share", first["action"])
	assert.Equal(t, map[string]any{"existing": "0"}, first["args"], "so a second link on a shared file is visible before it is approved")

	// Nothing exists yet: the model asked, the person has not answered.
	node := nodeAt(t, store, "main://notes/hello.txt")
	before, err := store.ListSharesByNode(context.Background(), node.ID)
	require.NoError(t, err)
	assert.Empty(t, before, "a proposed plan mints nothing")

	planID, _ := card["plan_id"].(string)
	require.NotEmpty(t, planID)
	outcome := approvePlan(t, client, srv.URL, session, planID)
	assert.Equal(t, 1, outcome.Done)
	require.Len(t, outcome.Items, 1)

	url, _ := outcome.Items[0]["url"].(string)
	require.NotEmpty(t, url, "the link is the whole point of approving this plan; a result without it is useless")
	assert.True(t, strings.HasPrefix(url, "http://test.local/s/"), "built on the request's origin, got %q", url)

	after, err := store.ListSharesByNode(context.Background(), node.ID)
	require.NoError(t, err)
	require.Len(t, after, 1, "and it is a real link, not only a string in the answer")
	assert.Equal(t, "http://test.local/s/"+after[0].Token, url)
	require.NotNil(t, after[0].ExpiresAt, "the service clamps a missing expiry to the operator's max TTL")
}

func TestAssistantPlan_ShareLinkIsNotMintedForAFileThatChanged(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_create_share", map[string]any{
			"path": "main://notes/hello.txt", "summary": "Share the notes file by link",
		}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	card := planCard(t, turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "share it"))
	planID, _ := card["plan_id"].(string)

	// Somebody replaces the file between the proposal and the approval.
	node := nodeAt(t, store, "main://notes/hello.txt")
	require.NoError(t, store.UpdateNodeMeta(context.Background(), node.ID, 4096, node.Mime, "etag-baska", node.DBMtime))

	outcome := approvePlan(t, client, srv.URL, session, planID)
	assert.Equal(t, 0, outcome.Done)
	assert.Equal(t, 1, outcome.Skipped)
	require.Len(t, outcome.Items, 1)
	assert.Equal(t, "changed", outcome.Items[0]["code"])
	assert.Empty(t, outcome.Items[0]["url"])

	links, err := store.ListSharesByNode(context.Background(), node.ID)
	require.NoError(t, err)
	assert.Empty(t, links, "the approval was for the file they were shown, not for whatever replaced it")
}
