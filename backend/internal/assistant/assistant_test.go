package assistant

// The model side, pinned where it is easy to get wrong: what the two wire
// protocols actually emit, what happens to a stored key that will not decrypt,
// and the two limits that stop a runaway client.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/secretbox"
)

// memStore is a settings table in a map.
type memStore struct {
	mu   sync.Mutex
	rows map[string]string
}

func newMem() *memStore { return &memStore{rows: map[string]string{}} }

func (m *memStore) GetSetting(_ context.Context, key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rows[key], nil
}

func (m *memStore) UpsertSetting(_ context.Context, key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[key] = value
	return nil
}

// sseServer answers one streaming request with the given frames.
func sseServer(t *testing.T, seen *http.Header, frames ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = r.Header.Clone()
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for _, frame := range frames {
			fmt.Fprint(w, frame)
			w.(http.Flusher).Flush()
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func collect(t *testing.T, cfg Config, srv *httptest.Server) (string, error) {
	t.Helper()
	cfg.BaseURL = srv.URL
	provider, err := NewProvider(cfg, srv.Client())
	require.NoError(t, err)
	var out strings.Builder
	_, err = provider.Stream(context.Background(), Request{Model: "m", System: "s", Messages: []Message{{Role: "user", Content: "hi"}}},
		func(delta string) error {
			out.WriteString(delta)
			return nil
		})
	return out.String(), err
}

func TestOpenAIStream_AssemblesDeltasAndStopsAtDone(t *testing.T) {
	var seen http.Header
	srv := sseServer(t, &seen,
		"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
		// A frame this client does not know must not throw away the answer.
		"data: {\"choices\":[{\"delta\":{\"reasoning\":\"…\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
		"data: [DONE]\n\n",
		// Anything after the terminator is not part of the answer.
		"data: {\"choices\":[{\"delta\":{\"content\":\" and more\"}}]}\n\n",
	)
	text, err := collect(t, Config{Provider: ProviderOpenAI, APIKey: "k"}, srv)
	require.NoError(t, err)
	assert.Equal(t, "Hello", text)
	assert.Equal(t, "Bearer k", seen.Get("Authorization"))
}

func TestAnthropicStream_ReadsNamedEvents(t *testing.T) {
	var seen http.Header
	srv := sseServer(t, &seen,
		"event: message_start\ndata: {}\n\n",
		"event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
		"event: ping\ndata: {}\n\n",
		"event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
		"event: message_stop\ndata: {}\n\n",
	)
	text, err := collect(t, Config{Provider: ProviderAnthropic, APIKey: "k"}, srv)
	require.NoError(t, err)
	assert.Equal(t, "Hello", text)
	assert.Equal(t, "k", seen.Get("x-api-key"), "the key travels in x-api-key, not Authorization")
	assert.Equal(t, anthropicVersion, seen.Get("anthropic-version"))
}

// ⚠ The provider's own words are what an operator needs — "model not found" is
// actionable and "the assistant failed" is not.
func TestStream_QuotesTheProvidersError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error":{"message":"The model `+"`nope`"+` does not exist"}}`)
	}))
	t.Cleanup(srv.Close)
	_, err := collect(t, Config{Provider: ProviderOpenAI, APIKey: "k"}, srv)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "404")
	assert.Contains(t, err.Error(), "does not exist")
	assert.Equal(t, ErrorCodeUnavailable, ErrorCode(err), "a model that is gone is the assistant being gone")
}

// The person is told what KIND of failure it was when there is something they
// can do about it: out of credit is an administrator's problem, an assistant
// that is gone is not coming back on retry. Everything else stays generic.
func TestErrorCode_TellsQuotaAndUnavailableApart(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"402", &ProviderError{Status: http.StatusPaymentRequired}, ErrorCodeQuota},
		{"openai's 429 for no credit", &ProviderError{Status: http.StatusTooManyRequests, Detail: `{"error":{"code":"insufficient_quota"}}`}, ErrorCodeQuota},
		{"anthropic's 400 for no credit", &ProviderError{Status: http.StatusBadRequest, Detail: `{"error":{"message":"Your credit balance is too low"}}`}, ErrorCodeQuota},
		{"a real rate limit", &ProviderError{Status: http.StatusTooManyRequests, Detail: `{"error":{"code":"rate_limit_exceeded"}}`}, ""},
		{"revoked key", &ProviderError{Status: http.StatusUnauthorized}, ErrorCodeUnavailable},
		{"model gone", &ProviderError{Status: http.StatusNotFound}, ErrorCodeUnavailable},
		{"switched off", ErrNotConfigured, ErrorCodeUnavailable},
		{"wrapped", fmt.Errorf("assistant: %w", &ProviderError{Status: http.StatusForbidden}), ErrorCodeUnavailable},
		{"overloaded", &ProviderError{Status: http.StatusServiceUnavailable}, ""},
		{"network", fmt.Errorf("assistant: dial tcp: connection refused"), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, ErrorCode(tc.err))
		})
	}
}

// Stopping is something a person does on purpose, so it is not an error and
// what arrived before the stop is kept.
func TestStream_CancellationKeepsWhatArrived(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"half \"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-release
	}))
	t.Cleanup(func() { close(release); srv.Close() })

	provider, err := NewProvider(Config{Provider: ProviderOpenAI, BaseURL: srv.URL, APIKey: "k"}, srv.Client())
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	var out strings.Builder
	_, err = provider.Stream(ctx, Request{Model: "m", Messages: []Message{{Role: "user", Content: "hi"}}}, func(delta string) error {
		out.WriteString(delta)
		cancel()
		return nil
	})
	require.NoError(t, err, "a stop is not a failure")
	assert.Equal(t, "half ", out.String())
}

func TestConfig_EndpointDefaultsPerProvider(t *testing.T) {
	assert.Equal(t, DefaultOpenAIBaseURL, Config{Provider: ProviderOpenAI}.Endpoint())
	assert.Equal(t, DefaultAnthropicBaseURL, Config{Provider: ProviderAnthropic}.Endpoint())
	// An openai-compatible server of one's own, trailing slash and all.
	assert.Equal(t, "http://vllm:8000/v1", Config{Provider: ProviderOpenAI, BaseURL: "http://vllm:8000/v1/"}.Endpoint())
	// A bare host is refused at save time rather than discovered at ask time.
	assert.Error(t, BaseURLSetting.Validate("vllm:8000"))
	assert.NoError(t, BaseURLSetting.Validate(""))
}

func TestKey_SealedRoundTripAndTheThreeWaysItCanBeUnusable(t *testing.T) {
	ctx := context.Background()
	box, err := secretbox.New("unit-test-key")
	require.NoError(t, err)
	store := newMem()
	require.NoError(t, store.UpsertSetting(ctx, EnabledSetting.Key, "true"))
	require.NoError(t, store.UpsertSetting(ctx, ModelSetting.Key, "some-model"))

	// No key yet: not ready, and the reason names what is missing.
	cfg := Load(ctx, store, box)
	assert.False(t, cfg.Ready())
	assert.Contains(t, cfg.Problem, "no API key")

	require.NoError(t, StoreKey(ctx, store, box, "sk-secret"))
	sealed, _ := store.GetSetting(ctx, apiKeySetting)
	assert.NotContains(t, sealed, "sk-secret", "the key is not stored in the clear")
	assert.True(t, HasKey(ctx, store))

	cfg = Load(ctx, store, box)
	require.True(t, cfg.Ready())
	assert.Equal(t, "sk-secret", cfg.APIKey)

	// Sealed under a different key — what an operator sees after rotating
	// FILEX_SECRET_KEY. Reported, not silently treated as "not configured".
	other, err := secretbox.New("a-different-key")
	require.NoError(t, err)
	cfg = Load(ctx, store, other)
	assert.False(t, cfg.Ready())
	assert.Contains(t, cfg.Problem, "re-enter")

	// No encryption key at all: the stored ciphertext cannot be read, and a
	// new key cannot be stored in the clear instead.
	none, err := secretbox.New("")
	require.NoError(t, err)
	cfg = Load(ctx, store, none)
	assert.False(t, cfg.Ready())
	assert.Contains(t, cfg.Problem, "FILEX_SECRET_KEY")
	assert.ErrorIs(t, StoreKey(ctx, store, none, "sk-plain"), secretbox.ErrNoKey)

	// Removing the key leaves the rest of the configuration alone.
	require.NoError(t, StoreKey(ctx, store, box, ""))
	assert.False(t, HasKey(ctx, store))
	assert.Equal(t, "some-model", Load(ctx, store, box).Model)
}

// A switched-off assistant is not a misconfigured one: no key and no model are
// the normal state of an install that never wanted it, and Problem stays empty
// so no admin page shows a red line about a feature nobody enabled.
func TestConfig_OffIsNotAProblem(t *testing.T) {
	cfg := Load(context.Background(), newMem(), nil)
	assert.False(t, cfg.Enabled)
	assert.False(t, cfg.Ready())
	assert.Empty(t, cfg.Problem)
}

func TestTrimHistory_MergesAndWindows(t *testing.T) {
	// An aborted turn leaves two user messages in a row, which Anthropic
	// refuses outright; they are merged rather than sent.
	got := trimHistory([]Message{
		{Role: "user", Content: "first"},
		{Role: "user", Content: "second"},
		{Role: "assistant", Content: "  "},
		{Role: "assistant", Content: "answer"},
	})
	require.Len(t, got, 2)
	assert.Equal(t, "first\n\nsecond", got[0].Content)
	assert.Equal(t, "answer", got[1].Content)

	// The window keeps the recent turns and never opens on a reply whose
	// question was cut off.
	long := make([]Message, 0, MaxHistoryMessages+3)
	for i := 0; i < MaxHistoryMessages+3; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		long = append(long, Message{Role: role, Content: fmt.Sprintf("m%d", i)})
	}
	windowed := trimHistory(long)
	assert.LessOrEqual(t, len(windowed), MaxHistoryMessages)
	assert.Equal(t, "user", windowed[0].Role)
}

func TestBegin_OneTurnAtATimeAndAPerMinuteCeiling(t *testing.T) {
	svc := New(newMem(), nil)

	release, err := svc.Begin(7, 10)
	require.NoError(t, err)
	_, err = svc.Begin(7, 10)
	assert.ErrorIs(t, err, ErrBusy, "a second turn would interleave two answers in one conversation")

	// Another account is unaffected — the limits are per user, not global.
	otherRelease, err := svc.Begin(8, 10)
	require.NoError(t, err)
	otherRelease()
	release()

	// The loop-breaker: a ceiling no human types past and no loop survives.
	limited := New(newMem(), nil)
	for i := 0; i < 2; i++ {
		rel, err := limited.Begin(7, 2)
		require.NoError(t, err)
		rel()
	}
	_, err = limited.Begin(7, 2)
	assert.ErrorIs(t, err, ErrRateLimited)
}

func TestAsk_RefusesWhenNotConfigured(t *testing.T) {
	svc := New(newMem(), nil)
	err := svc.Ask(context.Background(), Config{Enabled: true}, nil, []Message{{Role: "user", Content: "hi"}}, func(Event) error { return nil })
	assert.ErrorIs(t, err, ErrNotConfigured)
}

// The prompt is the one place the owner's rules are written down; these are the
// lines that must not quietly go missing in an edit.
func TestSystemPrompt_CarriesTheRulesItMustCarry(t *testing.T) {
	prompt := SystemPrompt(nil)
	for _, required := range []string{
		"highest priority",
		"NO undo",
		"Nothing has happened yet",
		"do not \"try something and see\"",
		"Permission is per file",
		"tell the user immediately",
		"never on your own initiative",
		"change permissions",
		"storage://path",
		"more than 20 files",
	} {
		assert.Contains(t, prompt, required, "the system prompt lost: %s", required)
	}
	assert.Contains(t, prompt, fmt.Sprintf("%d files", MaxFilesPerListing))
	// With no tools registered it says so, instead of inviting the model to
	// describe files it cannot see.
	assert.Contains(t, prompt, "you have no tools")
	assert.NotContains(t, SystemPrompt([]string{"list_files — lists a folder"}), "you have no tools")
}

func TestService_ConfigIsReadPerCall(t *testing.T) {
	ctx := context.Background()
	store := newMem()
	box, err := secretbox.New("unit-test-key")
	require.NoError(t, err)
	svc := New(store, box)
	assert.False(t, svc.Config(ctx).Enabled)

	require.NoError(t, store.UpsertSetting(ctx, EnabledSetting.Key, "true"))
	require.NoError(t, store.UpsertSetting(ctx, ModelSetting.Key, "m"))
	require.NoError(t, StoreKey(ctx, store, box, "sk"))
	// No restart: an operator's change is in force on the next question.
	assert.True(t, svc.Config(ctx).Ready())
	assert.Equal(t, RateLimitSetting.Default, svc.Config(ctx).TurnsPerMinute)
}

func TestSeedSettings_FirstBootOnly(t *testing.T) {
	ctx := context.Background()
	t.Setenv("FILEX_ASSISTANT_MODEL", "seeded-model")
	t.Setenv(apiKeyEnv, "sk-from-env")
	box, err := secretbox.New("unit-test-key")
	require.NoError(t, err)
	store := newMem()

	SeedSettings(ctx, store, box)
	assert.Equal(t, "seeded-model", ModelSetting.Resolve(ctx, store))
	assert.Equal(t, "sk-from-env", Load(ctx, store, box).APIKey)

	// The variable is inert once the row exists — the admin page owns it now.
	t.Setenv("FILEX_ASSISTANT_MODEL", "changed-in-compose")
	t.Setenv(apiKeyEnv, "sk-changed-in-compose")
	SeedSettings(ctx, store, box)
	assert.Equal(t, "seeded-model", ModelSetting.Resolve(ctx, store))
	assert.Equal(t, "sk-from-env", Load(ctx, store, box).APIKey)
}

// A key that cannot be sealed is not stored at all. The alternative — writing
// it in the clear "for now" — is the failure this refuses to have.
func TestSeedKey_WithoutAnEncryptionKeyStoresNothing(t *testing.T) {
	ctx := context.Background()
	t.Setenv(apiKeyEnv, "sk-from-env")
	none, err := secretbox.New("")
	require.NoError(t, err)
	store := newMem()
	SeedSettings(ctx, store, none)
	assert.False(t, HasKey(ctx, store))
}

func TestRequestTimeoutIsSane(t *testing.T) {
	assert.Equal(t, requestTimeout, New(newMem(), nil).client.Timeout)
	assert.Greater(t, requestTimeout, time.Minute)
}

// fakeBox is a toolbox that answers from a script and records what it was asked.
type fakeBox struct {
	answers map[string]ToolOutcome
	calls   []ToolCall
}

func (b *fakeBox) Specs() []ToolSpec {
	return []ToolSpec{{Name: "list_folder", Description: "lists a folder", Schema: map[string]any{"type": "object"}}}
}

func (b *fakeBox) Run(_ context.Context, call ToolCall) ToolOutcome {
	b.calls = append(b.calls, call)
	if outcome, ok := b.answers[call.Name]; ok {
		return outcome
	}
	return ToolOutcome{Content: `{"ok":true}`}
}

// ⚠ Arguments arrive a few characters at a time and the id and name arrive
// once, at the start. A client that read each frame as a whole call would send
// the model a tool call with `{"pa` as its arguments.
func TestOpenAIStream_AssemblesAToolCallFromItsFragments(t *testing.T) {
	srv := sseServer(t, nil,
		"data: {\"choices\":[{\"delta\":{\"content\":\"Looking…\"}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"list_folder\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"main://Docs\\\"}\"}}]}}]}\n\n",
		"data: [DONE]\n\n",
	)
	provider, err := NewProvider(Config{Provider: ProviderOpenAI, BaseURL: srv.URL, APIKey: "k"}, srv.Client())
	require.NoError(t, err)
	var text strings.Builder
	calls, err := provider.Stream(context.Background(), Request{Model: "m"}, func(d string) error {
		text.WriteString(d)
		return nil
	})
	require.NoError(t, err)
	assert.Equal(t, "Looking…", text.String())
	require.Len(t, calls, 1)
	assert.Equal(t, ToolCall{ID: "call_1", Name: "list_folder", Args: `{"path":"main://Docs"}`}, calls[0])
}

func TestAnthropicStream_AssemblesAToolUseFromItsFragments(t *testing.T) {
	srv := sseServer(t, nil,
		"event: content_block_start\ndata: {\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
		"event: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Looking…\"}}\n\n",
		"event: content_block_start\ndata: {\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"list_folder\"}}\n\n",
		"event: content_block_delta\ndata: {\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\"\"}}\n\n",
		"event: content_block_delta\ndata: {\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\":\\\"main://Docs\\\"}\"}}\n\n",
		"event: message_stop\ndata: {}\n\n",
	)
	provider, err := NewProvider(Config{Provider: ProviderAnthropic, BaseURL: srv.URL, APIKey: "k"}, srv.Client())
	require.NoError(t, err)
	var text strings.Builder
	calls, err := provider.Stream(context.Background(), Request{Model: "m"}, func(d string) error {
		text.WriteString(d)
		return nil
	})
	require.NoError(t, err)
	assert.Equal(t, "Looking…", text.String(), "text and tool arguments share one event type and must not be confused")
	require.Len(t, calls, 1)
	assert.Equal(t, ToolCall{ID: "tu_1", Name: "list_folder", Args: `{"path":"main://Docs"}`}, calls[0])
}

// ⚠⚠ Anthropic refuses a conversation whose turns do not alternate, and a tool
// result is a USER turn. Two tools run in one round must therefore arrive as
// one user message with two blocks — not as two user messages.
func TestAnthropicMessages_ToolResultsMergeIntoOneUserTurn(t *testing.T) {
	rendered := anthropicMessages([]Message{
		{Role: RoleUser, Content: "what is in Docs?"},
		{Role: RoleAssistant, Content: "Looking…", ToolCalls: []ToolCall{
			{ID: "tu_1", Name: "list_folder", Args: `{"path":"main://Docs"}`},
			{ID: "tu_2", Name: "list_folder", Args: `{"path":"main://Photos"}`},
		}},
		{Role: RoleTool, ToolCallID: "tu_1", Content: `{"entries":[]}`},
		{Role: RoleTool, ToolCallID: "tu_2", Content: `{"entries":[]}`},
	})
	require.Len(t, rendered, 3)
	assert.Equal(t, RoleUser, rendered[0].Role)
	assert.Equal(t, RoleAssistant, rendered[1].Role)

	assistantBlocks, ok := rendered[1].Content.([]any)
	require.True(t, ok, "an assistant turn with tool calls is a block list")
	require.Len(t, assistantBlocks, 3, "the text plus one block per call")
	firstCall := assistantBlocks[1].(map[string]any)
	assert.Equal(t, "tool_use", firstCall["type"])
	assert.Equal(t, map[string]any{"path": "main://Docs"}, firstCall["input"], "arguments travel as an object, not as the string they arrived in")

	assert.Equal(t, RoleUser, rendered[2].Role)
	results, ok := rendered[2].Content.([]any)
	require.True(t, ok)
	require.Len(t, results, 2, "both results in ONE user turn, or the API refuses the conversation")
	assert.Equal(t, "tu_1", results[0].(map[string]any)["tool_use_id"])
	assert.Equal(t, "tu_2", results[1].(map[string]any)["tool_use_id"])
}

func TestAsk_RunsTheToolAndCarriesItsResultBack(t *testing.T) {
	var round int
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(body))
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if round == 0 {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"list_folder\",\"arguments\":\"{}\"}}]}}]}\n\n")
		} else {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Two files.\"}}]}\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		round++
	}))
	t.Cleanup(srv.Close)

	box := &fakeBox{answers: map[string]ToolOutcome{
		"list_folder": {Content: `{"entries":["a.txt"]}`, Card: &Card{Kind: CardApproval, Path: "main://a.txt", Reason: "why"}},
	}}
	var events []Event
	svc := New(newMem(), nil)
	err := svc.Ask(context.Background(),
		Config{Enabled: true, Provider: ProviderOpenAI, BaseURL: srv.URL, Model: "m", APIKey: "k"},
		box, []Message{{Role: RoleUser, Content: "what is in Docs?"}},
		func(e Event) error {
			events = append(events, e)
			return nil
		})
	require.NoError(t, err)

	require.Len(t, box.calls, 1)
	assert.Equal(t, "list_folder", box.calls[0].Name)
	// The panel is told what is happening, then what the person has to decide,
	// then the answer.
	kinds := []string{}
	for _, e := range events {
		kinds = append(kinds, e.Type)
	}
	assert.Equal(t, []string{EventTool, EventCard, EventText}, kinds)
	assert.Equal(t, "main://a.txt", events[1].Card.Path)
	assert.Equal(t, "Two files.", events[2].Delta)

	require.Len(t, bodies, 2)
	assert.Contains(t, bodies[1], `"role":"tool"`)
	assert.Contains(t, bodies[1], "a.txt", "the result went back to the model")
	assert.Contains(t, bodies[0], `"tools":[`, "and the tools were offered in the first place")
}

// A model that keeps calling tools is stopped by the round cap, and the person
// is told rather than left with a turn that just ends.
func TestAsk_StopsAfterTooManyToolRounds(t *testing.T) {
	var rounds int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		rounds++
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"list_folder\",\"arguments\":\"{}\"}}]}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)

	var last string
	err := New(newMem(), nil).Ask(context.Background(),
		Config{Enabled: true, Provider: ProviderOpenAI, BaseURL: srv.URL, Model: "m", APIKey: "k"},
		&fakeBox{}, []Message{{Role: RoleUser, Content: "loop"}},
		func(e Event) error {
			if e.Type == EventText {
				last = e.Delta
			}
			return nil
		})
	require.NoError(t, err)
	assert.Equal(t, MaxToolRounds, rounds)
	assert.Contains(t, last, "I stopped after looking at too many things")
}

// The prompt's tool inventory is built from the tools that are really there.
func TestSystemPrompt_ListsTheToolsTheDeploymentHas(t *testing.T) {
	prompt := SystemPrompt(toolNames(&fakeBox{}))
	assert.Contains(t, prompt, "# Your tools")
	assert.Contains(t, prompt, "`list_folder` — lists a folder")
	assert.NotContains(t, prompt, "you have no tools")
}

// A tool result can show the model a picture. Each protocol carries it where
// it allows one: Anthropic inside the tool_result block, the openai-compatible
// dialect as a user turn of parts right after the text-only tool message.
func TestMessages_CarryAToolResultsPicture(t *testing.T) {
	req := Request{Messages: []Message{
		{Role: RoleUser, Content: "what is in the picture?"},
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "call_1", Name: "view_image", Args: `{"path":"main://a.png"}`}}},
		{Role: RoleTool, ToolCallID: "call_1", Content: `{"path":"main://a.png"}`, Images: []Image{{Mime: "image/jpeg", Data: []byte("JPEGBYTES")}}},
	}}
	encoded := "SlBFR0JZVEVT" // base64 of JPEGBYTES

	anthropic, err := json.Marshal(anthropicMessages(req.Messages))
	require.NoError(t, err)
	assert.Contains(t, string(anthropic), `"type":"tool_result"`)
	assert.Contains(t, string(anthropic), `"type":"image"`)
	assert.Contains(t, string(anthropic), `"media_type":"image/jpeg"`)
	assert.Contains(t, string(anthropic), `"data":"`+encoded+`"`)
	assert.Equal(t, 3, len(anthropicMessages(req.Messages)), "the picture rides on the result, not as a turn of its own")

	openai := openAIMessages(req)
	require.Len(t, openai, 4, "tool message, then the user turn that carries the picture")
	assert.Equal(t, RoleTool, openai[2].Role)
	assert.Equal(t, `{"path":"main://a.png"}`, openai[2].Content, "the tool message stays text — this dialect takes nothing else there")
	assert.Equal(t, RoleUser, openai[3].Role)
	parts, err := json.Marshal(openai[3].Content)
	require.NoError(t, err)
	assert.Contains(t, string(parts), `"type":"image_url"`)
	assert.Contains(t, string(parts), `"url":"data:image/jpeg;base64,`+encoded+`"`)
}
