package handlers_test

// One question, end to end: the admin configures a provider, the panel asks,
// the answer streams back, and both halves of the exchange are in the log
// afterwards. The provider is a fake server speaking the openai-compatible
// wire protocol — the point is filex's half of the conversation, not a
// vendor's.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/config"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// fakeProvider answers every call with the same three-delta stream. block, when
// non-nil, holds the connection open after the first delta so a test can stop
// a turn half-way.
func fakeProvider(t *testing.T, block chan struct{}) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flush := func(frame string) {
			fmt.Fprint(w, frame)
			w.(http.Flusher).Flush()
		}
		flush("data: {\"choices\":[{\"delta\":{\"content\":\"Your \"}}]}\n\n")
		if block != nil {
			<-block
			return
		}
		flush("data: {\"choices\":[{\"delta\":{\"content\":\"files \"}}]}\n\n")
		flush("data: {\"choices\":[{\"delta\":{\"content\":\"are fine.\"}}]}\n\n")
		flush("data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv
}

// assistantServer boots filex with an encryption key configured — without one
// the provider key could not be sealed, and the assistant refuses to store it
// in the clear.
func assistantServer(t *testing.T) (*httptest.Server, *http.Client, db.Store) {
	t.Helper()
	return testutil.NewTestServerCfg(t, func(c *config.Config) { c.SecretKey = "assistant-test-key" })
}

// turnEvents opens one turn and returns the decoded events in order.
func turnEvents(t *testing.T, ctx context.Context, client *http.Client, url, prompt string, onFirst func()) []map[string]any {
	t.Helper()
	body, err := json.Marshal(map[string]string{"prompt": prompt})
	require.NoError(t, err)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(resp.Body)
		require.Equal(t, http.StatusOK, resp.StatusCode, "turn: %s", detail)
	}
	assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))

	var events []map[string]any
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event map[string]any
		require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event))
		events = append(events, event)
		if event["type"] == "text" && onFirst != nil {
			onFirst()
			return events
		}
	}
	return events
}

func configureAssistant(t *testing.T, srv *httptest.Server, admin *http.Client, patch map[string]any) {
	t.Helper()
	st, raw := doReq(t, admin, http.MethodPut, srv.URL+"/api/admin/assistant/provider", patch)
	require.Equal(t, http.StatusOK, st, "configure: %s", raw)
}

func newSession(t *testing.T, srv *httptest.Server, client *http.Client) string {
	t.Helper()
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions", map[string]any{})
	require.Equal(t, http.StatusOK, st, "create session: %s", raw)
	var created struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	require.NoError(t, json.Unmarshal(raw, &created))
	return created.Session.ID
}

func TestAssistantTurn_StreamsTheAnswerAndKeepsBothHalves(t *testing.T) {
	provider := fakeProvider(t, nil)
	srv, admin, store := assistantServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, admin, email, pw)

	// Before anything is configured the panel is not offered at all.
	st, raw := doReq(t, admin, http.MethodGet, srv.URL+"/api/assistant/status", nil)
	require.Equal(t, http.StatusOK, st)
	assert.JSONEq(t, `{"enabled":false}`, string(raw))

	configureAssistant(t, srv, admin, map[string]any{
		"enabled": true, "provider": "openai", "base_url": provider.URL,
		"model": "test-model", "api_key": "sk-test", "turns_per_minute": 20,
	})

	st, raw = doReq(t, admin, http.MethodGet, srv.URL+"/api/assistant/status", nil)
	require.Equal(t, http.StatusOK, st)
	var status struct {
		Enabled bool   `json:"enabled"`
		Model   string `json:"model"`
	}
	require.NoError(t, json.Unmarshal(raw, &status))
	assert.True(t, status.Enabled)
	assert.Equal(t, "test-model", status.Model)

	session := newSession(t, srv, admin)
	events := turnEvents(t, context.Background(), admin, srv.URL+"/api/assistant/sessions/"+session+"/turn", "How are my files?", nil)

	require.NotEmpty(t, events)
	assert.Equal(t, "meta", events[0]["type"], "the conversation id comes first")
	assert.Equal(t, session, events[0]["conversation_id"])
	assert.Equal(t, "done", events[len(events)-1]["type"])
	var answer strings.Builder
	for _, event := range events {
		if event["type"] == "text" {
			answer.WriteString(event["delta"].(string))
		}
		assert.NotEqual(t, "error", event["type"], "no error event: %v", event)
	}
	assert.Equal(t, "Your files are fine.", answer.String())

	// Both halves are in the log — the question was stored before the model was
	// called, the answer when the stream ended.
	st, raw = doReq(t, admin, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var log struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
			Aborted bool   `json:"aborted"`
		} `json:"messages"`
		Session struct {
			MessageCount int `json:"message_count"`
		} `json:"session"`
	}
	require.NoError(t, json.Unmarshal(raw, &log))
	require.Len(t, log.Messages, 2)
	assert.Equal(t, "user", log.Messages[0].Role)
	assert.Equal(t, "How are my files?", log.Messages[0].Content)
	assert.Equal(t, "assistant", log.Messages[1].Role)
	assert.Equal(t, "Your files are fine.", log.Messages[1].Content)
	assert.False(t, log.Messages[1].Aborted)
	assert.Equal(t, 2, log.Session.MessageCount)
}

// ⚠ The behaviour the owner asked for by name: a partial answer that reached
// the session stays in it. Somebody who pressed stop had read the beginning.
func TestAssistantTurn_StoppedMidAnswerKeepsWhatWasWritten(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	provider := fakeProvider(t, block)
	srv, admin, store := assistantServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, admin, email, pw)
	configureAssistant(t, srv, admin, map[string]any{
		"enabled": true, "provider": "openai", "base_url": provider.URL,
		"model": "test-model", "api_key": "sk-test",
	})
	session := newSession(t, srv, admin)

	ctx, cancel := context.WithCancel(context.Background())
	events := turnEvents(t, ctx, admin, srv.URL+"/api/assistant/sessions/"+session+"/turn", "stop me", cancel)
	require.Len(t, events, 2, "meta, then the delta the reader saw")

	// The handler persists after the client is gone, on a context of its own.
	require.Eventually(t, func() bool {
		st, raw := doReq(t, admin, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
		if st != http.StatusOK {
			return false
		}
		var log struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
				Aborted bool   `json:"aborted"`
			} `json:"messages"`
		}
		if json.Unmarshal(raw, &log) != nil || len(log.Messages) != 2 {
			return false
		}
		return log.Messages[1].Content == "Your " && log.Messages[1].Aborted
	}, 5*time.Second, 50*time.Millisecond, "the partial answer must survive the stop, marked as stopped")
}

// The loop-breaker. A person cannot type past this; an agent talking to itself
// reaches it immediately.
func TestAssistantTurn_RateLimitBreaksALoop(t *testing.T) {
	provider := fakeProvider(t, nil)
	srv, admin, store := assistantServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, admin, email, pw)
	configureAssistant(t, srv, admin, map[string]any{
		"enabled": true, "provider": "openai", "base_url": provider.URL,
		"model": "test-model", "api_key": "sk-test", "turns_per_minute": 1,
	})
	session := newSession(t, srv, admin)

	turnEvents(t, context.Background(), admin, srv.URL+"/api/assistant/sessions/"+session+"/turn", "first", nil)
	st, raw := doReq(t, admin, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/turn", map[string]any{"prompt": "again"})
	assert.Equal(t, http.StatusTooManyRequests, st, "the second turn inside the minute is refused: %s", raw)

	// And an out-of-range ceiling is refused where the operator can see it.
	st, _ = doReq(t, admin, http.MethodPut, srv.URL+"/api/admin/assistant/provider", map[string]any{"turns_per_minute": 0})
	assert.Equal(t, http.StatusBadRequest, st)
}

// The key goes in and never comes back out.
func TestAssistantProvider_KeyIsWriteOnly(t *testing.T) {
	srv, admin, store := assistantServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, admin, email, pw)
	configureAssistant(t, srv, admin, map[string]any{
		"enabled": true, "provider": "anthropic", "model": "test-model", "api_key": "sk-very-secret",
	})

	st, raw := doReq(t, admin, http.MethodGet, srv.URL+"/api/admin/assistant/provider", nil)
	require.Equal(t, http.StatusOK, st)
	assert.NotContains(t, string(raw), "sk-very-secret", "the admin page never reads the key back")
	var view struct {
		HasKey   bool   `json:"has_key"`
		Ready    bool   `json:"ready"`
		Endpoint string `json:"endpoint"`
		Problem  string `json:"problem"`
	}
	require.NoError(t, json.Unmarshal(raw, &view))
	assert.True(t, view.HasKey)
	assert.True(t, view.Ready)
	assert.Equal(t, "https://api.anthropic.com/v1", view.Endpoint, "the provider's own endpoint when none is given")
	assert.Empty(t, view.Problem)

	// Not stored in the clear either — the row an operator could read is sealed.
	stored, err := store.GetSetting(context.Background(), "assistant.api_key")
	require.NoError(t, err)
	assert.NotEmpty(t, stored)
	assert.NotContains(t, stored, "sk-very-secret")

	// The redaction marker means "unchanged": a form that re-sends what it was
	// shown must not replace a working key with three asterisks.
	configureAssistant(t, srv, admin, map[string]any{"api_key": "***", "model": "another-model"})
	st, raw = doReq(t, admin, http.MethodGet, srv.URL+"/api/admin/assistant/provider", nil)
	require.Equal(t, http.StatusOK, st)
	require.NoError(t, json.Unmarshal(raw, &view))
	assert.True(t, view.Ready, "the key survived a save that did not mean to change it")
}

// An ordinary account cannot configure the provider, and asking on somebody
// else's conversation is still not found.
func TestAssistantTurn_IsScopedToItsOwner(t *testing.T) {
	provider := fakeProvider(t, nil)
	srv, admin, store := assistantServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, admin, email, pw)
	configureAssistant(t, srv, admin, map[string]any{
		"enabled": true, "provider": "openai", "base_url": provider.URL,
		"model": "test-model", "api_key": "sk-test",
	})
	session := newSession(t, srv, admin)

	createUser(t, srv.URL, admin, "ada@test.local", "AdaPass1!", "user")
	ada := freshClient(t)
	testutil.LoginAs(t, srv, ada, "ada@test.local", "AdaPass1!")

	st, _ := doReq(t, ada, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/turn", map[string]any{"prompt": "hers?"})
	assert.Equal(t, http.StatusNotFound, st, "another account cannot ask inside this conversation")
	st, _ = doReq(t, ada, http.MethodGet, srv.URL+"/api/admin/assistant/provider", nil)
	assert.Equal(t, http.StatusForbidden, st, "nor see how the provider is configured")
}
