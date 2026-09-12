package handlers_test

// Naming a conversation. The name is the only part of a conversation an
// administrator ever sees, so these tests are about what the naming call is
// allowed to be shown and what it is allowed to produce.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// chatRow reads one conversation back off the list.
func chatRow(t *testing.T, srv *httptest.Server, client *http.Client, id string) map[string]any {
	t.Helper()
	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions", nil)
	require.Equal(t, http.StatusOK, st)
	var out struct {
		Sessions []map[string]any `json:"sessions"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	for _, row := range out.Sessions {
		if row["id"] == id {
			return row
		}
	}
	t.Fatalf("no conversation %s in %v", id, out.Sessions)
	return nil
}

func TestAssistantTitle_NamesAnUnnamedConversation(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("There are four."))
	provider.titleFrame = textFrame("Counting the files in a folder")
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "how many files are there?")
	titles := eventsOfType(events, "title")
	require.Len(t, titles, 1, "the client is told the name as the turn ends, so the list does not need a refetch")
	assert.Equal(t, "Counting the files in a folder", titles[0]["title"])

	row := chatRow(t, srv, client, session)
	assert.Equal(t, "Counting the files in a folder", row["title"])
	assert.Equal(t, false, row["title_manual"], "a generated name is not a chosen one, and must stay replaceable")
}

// ⚠ The privacy rule, enforced by what is sent rather than by what the model
// is asked to do: the naming call sees the question and never the answer.
func TestAssistantTitle_IsShownTheQuestionAndNotTheAnswer(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("The salary review is in main://HR/salaries-2026.xlsx."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "where is the salary review?")
	sent := provider.nameRequests()
	assert.Contains(t, sent, "where is the salary review?")
	assert.NotContains(t, sent, "salaries-2026.xlsx", "the answer is where the file names are; it is not sent")
}

func TestAssistantTitle_LeavesANameSomebodyTypedAlone(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("Fine."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)
	st, _ := doReq(t, client, http.MethodPatch, srv.URL+"/api/assistant/sessions/"+session, map[string]any{"title": "Q3 contracts"})
	require.Equal(t, http.StatusOK, st)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "and now?")
	assert.Empty(t, eventsOfType(events, "title"))
	assert.Equal(t, 0, provider.namings(), "a conversation the person named is not named again — the call is not even made")
	assert.Equal(t, "Q3 contracts", chatRow(t, srv, client, session)["title"])
}

// A model that puts a file name in the title is refused, rather than trusted.
func TestAssistantTitle_RefusesANameThatCarriesAFileName(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("Here it is."))
	provider.titleFrame = textFrame("Reading budget-2026-final.xlsx")
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "open the budget")
	assert.Empty(t, eventsOfType(events, "title"))
	assert.Equal(t, "", chatRow(t, srv, client, session)["title"], "no name is better than one that leaks the file")
}

// The second turn of a conversation that already has a name costs nothing.
func TestAssistantTitle_IsAskedForOnceAndThenLeftAlone(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("One."), textFrame("Two."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "first question")
	turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "second question")
	assert.Equal(t, 1, provider.namings())
}
