package handlers_test

// The changing half of the assistant, tested where it can actually be wrong:
// nothing happens until the person approves, what happens is what the STORED
// plan says (not what the model asks for afterwards), and a file that moved
// under the plan is left alone.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// What the person decided is said by the EXECUTOR, in a message of its own.
//
// ⚠ The panel used to report this by sending a chat turn worded as the person
// ("I approved the plan. 1 done, 0 not done") — words nobody typed, stored in
// the transcript as theirs, and answered by a model turn that had nothing to
// add. The server states its own outcome now, as role `system`, and a plan that
// ran in full is the end of the exchange: the model is not called again.
func TestAssistantPlan_ApprovedPlanIsReportedByTheExecutor(t *testing.T) {
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
	rounds := provider.rounds()

	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var decided struct {
		Message struct {
			Role     string `json:"role"`
			Content  string `json:"content"`
			Decision struct {
				PlanID  string `json:"plan_id"`
				Status  string `json:"status"`
				Done    int    `json:"done"`
				Skipped int    `json:"skipped"`
			} `json:"plan_decision"`
		} `json:"message"`
	}
	require.NoError(t, json.Unmarshal(raw, &decided))
	assert.Equal(t, model.AssistantRoleSystem, decided.Message.Role, "the executor, not the person and not the model")
	assert.Equal(t, planID, decided.Message.Decision.PlanID)
	assert.Equal(t, model.PlanDone, decided.Message.Decision.Status)
	assert.Equal(t, 1, decided.Message.Decision.Done)
	assert.Equal(t, 0, decided.Message.Decision.Skipped)

	// In the conversation: one question the person asked, and nothing else in their name.
	roles, contents := conversation(t, client, srv, session)
	assert.Equal(t, []string{"user", "assistant", "system"}, roles)
	assert.Equal(t, "tag it", contents[0], "the only thing stored as the person's words is what they typed")
	assert.Contains(t, contents[2], "approved plan")

	// Nothing was left undone, so there is nothing to let the model back in for.
	st, raw = doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/turn", map[string]any{"resume": true})
	assert.Equal(t, http.StatusBadRequest, st, "resume: %s", raw)
	assert.Equal(t, rounds, provider.rounds(), "the model was not asked to say anything about a plan that ran in full")
}

// A refusal ends it. The executor records it, the model is not called, and the
// conversation waits for whatever the person asks next.
func TestAssistantPlan_RefusedPlanEndsTheExchange(t *testing.T) {
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
	rounds := provider.rounds()

	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/cancel", map[string]any{})
	require.Equal(t, http.StatusOK, st, "cancel: %s", raw)
	var decided struct {
		Message struct {
			Role     string `json:"role"`
			Content  string `json:"content"`
			Decision struct {
				Status string `json:"status"`
			} `json:"plan_decision"`
		} `json:"message"`
	}
	require.NoError(t, json.Unmarshal(raw, &decided))
	assert.Equal(t, model.AssistantRoleSystem, decided.Message.Role)
	assert.Equal(t, model.PlanCancelled, decided.Message.Decision.Status)
	assert.Contains(t, decided.Message.Content, "refused")

	roles, _ := conversation(t, client, srv, session)
	assert.Equal(t, []string{"user", "assistant", "system"}, roles, "nothing was said in the person's name")

	st, raw = doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/turn", map[string]any{"resume": true})
	assert.Equal(t, http.StatusBadRequest, st, "resume: %s", raw)
	assert.Equal(t, rounds, provider.rounds(), "a refusal is not something the model is asked to answer")
}

// conversation is the stored turns of one session: what each was, and what it said.
func conversation(t *testing.T, client *http.Client, srv *httptest.Server, session string) (roles, contents []string) {
	t.Helper()
	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st, "messages: %s", raw)
	var log struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &log))
	for _, m := range log.Messages {
		roles = append(roles, m.Role)
		contents = append(contents, m.Content)
	}
	return roles, contents
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

	// An item the plan did not do is work still outstanding, and the one case where the assistant is let back in —
	// without anybody typing anything — to deal with it.
	resumed := turnStreamWith(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", map[string]any{"resume": true}, nil)
	assert.NotEmpty(t, resumed, "the turn ran")
	roles, _ := conversation(t, client, srv, session)
	assert.Equal(t, []string{"user", "assistant", "system", "assistant"}, roles, "a resumed turn stores no question")
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

// A move is a plan like any other: the folder is created and the file moved
// only once the person approves, and the card names both steps in full.
func TestAssistantPlan_MoveCreatesTheFolderAndMovesOnlyAfterApproval(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_move", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "target": "main://sorted",
			"summary": "Create sorted and move hello.txt into it",
		}),
		textFrame("I have proposed the move."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "put hello.txt into a folder called sorted")
	card := planCard(t, events)
	assert.Equal(t, model.PlanKindMove, card["plan_kind"])
	items, _ := card["items"].([]any)
	require.Len(t, items, 2, "the new folder is a line of the plan, not a side effect")
	first, _ := items[0].(map[string]any)
	assert.Equal(t, "mkdir", first["action"])
	assert.Equal(t, "main://sorted", first["path"])
	second, _ := items[1].(map[string]any)
	assert.Equal(t, "move", second["action"])
	assert.Equal(t, "main://notes/hello.txt", second["path"])
	assert.Equal(t, map[string]any{"target": "main://sorted"}, second["args"])

	// Nothing has moved: the plan is a proposal.
	before := nodeAt(t, store, "main://notes/hello.txt")
	storages, err := store.ListEnabledStorages(context.Background())
	require.NoError(t, err)
	// GetNodeByPath answers a missing row with sql.ErrNoRows, so only the node is read.
	gone, _ := store.GetNodeByPath(context.Background(), storages[0].ID, pathkey.Hash(storages[0].ID, "sorted"))
	assert.Nil(t, gone, "no folder before the approval")

	planID, _ := card["plan_id"].(string)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var outcome struct {
		Done   int `json:"done"`
		Failed int `json:"failed"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Equal(t, 2, outcome.Done, "approve: %s", raw)
	assert.Equal(t, 0, outcome.Failed)

	moved := nodeAt(t, store, "main://sorted/hello.txt")
	assert.Equal(t, before.Size, moved.Size)
	old, _ := store.GetNodeByPath(context.Background(), storages[0].ID, pathkey.Hash(storages[0].ID, "notes/hello.txt"))
	assert.Nil(t, old, "the row followed the file")
}

// ⚠ Nothing is overwritten. A file that appeared under the destination name
// between the proposal and the approval — by another protocol, so the cache
// has not seen it — is left alone and the item reported as skipped.
func TestAssistantPlan_MoveNeverOverwrites(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_move", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "target": "main://archive", "summary": "Archive hello.txt",
		}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantFiles(t, provider)
	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "archive hello.txt")
	planID, _ := planCard(t, events)["plan_id"].(string)

	// Somebody writes archive/hello.txt straight to disk meanwhile.
	storages, err := store.ListEnabledStorages(context.Background())
	require.NoError(t, err)
	var cfg struct {
		Root string `json:"root"`
	}
	require.NoError(t, json.Unmarshal(storages[0].ConfigJSON, &cfg))
	require.NoError(t, os.MkdirAll(filepath.Join(cfg.Root, "archive"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(cfg.Root, "archive", "hello.txt"), []byte("theirs"), 0o644))

	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var outcome struct {
		Items []struct {
			Path  string `json:"path"`
			State string `json:"state"`
			Code  string `json:"code"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	require.Len(t, outcome.Items, 2)
	assert.Equal(t, "done", outcome.Items[0].State, "the folder itself is fine to have")
	assert.Equal(t, "skipped", outcome.Items[1].State)
	assert.Equal(t, "taken", outcome.Items[1].Code)

	theirs, err := os.ReadFile(filepath.Join(cfg.Root, "archive", "hello.txt"))
	require.NoError(t, err)
	assert.Equal(t, "theirs", string(theirs))
	nodeAt(t, store, "main://notes/hello.txt")
}

// A folder cannot be moved into itself, and the whole proposal is refused
// rather than trimmed: the person must never approve a list that lacks
// something they named.
func TestAssistantPlan_MoveIntoItselfIsRefused(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_move", map[string]any{
			"paths": []string{"main://notes"}, "target": "main://notes/inner", "summary": "Nest notes",
		}),
		textFrame("That cannot be done."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "move notes into notes/inner")
	assert.Empty(t, eventsOfType(events, "card"))
	assert.Contains(t, provider.sent(), "cannot be moved into itself")
}

// ⚠⚠ A plan runs ONCE, however many approvals arrive at the same moment.
//
// A double click, a proxy that retried, two tabs: the old code read the status,
// found `pending` in every request, ran the work in every request, and only
// then tried to close the row. For plan_create_share that minted a second
// public link whose URL was never shown to anybody — the loser got a 409 with
// no results at all. So the plan is claimed BEFORE a single item runs.
func TestAssistantPlan_ConcurrentApprovalsRunTheWorkOnce(t *testing.T) {
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
	require.NotEmpty(t, planID)

	// Eight at once rather than two: the window the old code left open is
	// short, and one racer that loses it proves nothing.
	const racers = 8
	url := srv.URL + "/api/assistant/sessions/" + session + "/plans/" + planID + "/approve"
	codes := make([]int, racers)
	start, wg, ready := make(chan struct{}), sync.WaitGroup{}, sync.WaitGroup{}
	ready.Add(racers)
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Warm up first, so what the barrier releases is eight requests on
			// eight open connections rather than eight TCP handshakes taking
			// turns — the window under test is a few hundred microseconds wide.
			warm, err := client.Get(srv.URL + "/api/assistant/sessions")
			if err == nil {
				_, _ = io.Copy(io.Discard, warm.Body)
				warm.Body.Close()
			}
			ready.Done()
			<-start
			// Never require/assert from here: a failed assertion in a goroutine
			// that is not the test's own aborts the process rather than the test.
			req, err := http.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
			if err != nil {
				codes[i] = -1
				return
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				codes[i] = -1
				return
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			codes[i] = resp.StatusCode
		}()
	}
	ready.Wait()
	close(start)
	wg.Wait()

	ok, conflict := 0, 0
	for _, code := range codes {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		}
	}
	assert.Equal(t, 1, ok, "exactly one approval runs the plan, got %v", codes)
	assert.Equal(t, racers-1, conflict, "every other approval is told the plan was already decided, got %v", codes)

	node := nodeAt(t, store, "main://notes/hello.txt")
	links, err := store.ListSharesByNode(context.Background(), node.ID)
	require.NoError(t, err)
	assert.Len(t, links, 1, "one approved plan is one link; a second one is a public URL nobody was ever shown")
}
