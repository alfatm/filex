package handlers_test

// The assistant looking at real files, through the real router, against a
// scripted provider.
//
// The test that matters most is the second one: a file's contents must not
// reach the model until the person has approved THAT file. It is asserted the
// only way worth asserting — by recording every byte filex sent the provider
// and looking for the file's text in it.

import (
	"bufio"
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

	"github.com/brf-tech/filex/backend/internal/api"
	"github.com/brf-tech/filex/backend/internal/auth"
	authlocal "github.com/brf-tech/filex/backend/internal/auth/drivers/local"
	"github.com/brf-tech/filex/backend/internal/capability"
	"github.com/brf-tech/filex/backend/internal/config"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/share"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	syncpkg "github.com/brf-tech/filex/backend/internal/sync"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// scriptedProvider answers each call with the next canned stream and records
// what it was sent, so a test can assert on what the model was shown.
type scriptedProvider struct {
	mu     sync.Mutex
	frames []string
	seen   []string
	calls  int
	srv    *httptest.Server
}

func newScriptedProvider(t *testing.T, frames ...string) *scriptedProvider {
	t.Helper()
	p := &scriptedProvider{frames: frames}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		p.mu.Lock()
		p.seen = append(p.seen, string(body))
		frame := "data: {\"choices\":[{\"delta\":{\"content\":\"(no script left)\"}}]}\n\n"
		if p.calls < len(p.frames) {
			frame = p.frames[p.calls]
		}
		p.calls++
		p.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, frame)
		fmt.Fprint(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	}))
	t.Cleanup(p.srv.Close)
	return p
}

// sent is everything filex sent the provider, with the system prompt cut out.
// The prompt is six kilobytes and would drown every failure message in it.
func (p *scriptedProvider) sent() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out strings.Builder
	for _, body := range p.seen {
		if at := strings.Index(body, `{"role":"user"`); at >= 0 {
			body = body[at:]
		}
		out.WriteString(body)
		out.WriteString("\n")
	}
	return out.String()
}

func (p *scriptedProvider) rounds() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

// toolFrame is one streamed tool call in the openai-compatible shape.
func toolFrame(id, name string, args map[string]any) string {
	raw, _ := json.Marshal(args)
	call, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{"delta": map[string]any{
			"tool_calls": []any{map[string]any{
				"index": 0, "id": id, "type": "function",
				"function": map[string]any{"name": name, "arguments": string(raw)},
			}},
		}}},
	})
	return "data: " + string(call) + "\n\n"
}

func textFrame(text string) string {
	raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
	return "data: " + string(raw) + "\n\n"
}

// assistantFiles boots filex over a real local-FS storage holding two files,
// with the assistant pointed at the scripted provider.
func assistantFiles(t *testing.T, provider *scriptedProvider) (*httptest.Server, *http.Client, db.Store) {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "notes"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes", "hello.txt"), []byte("nothing secret here"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes", "pay.csv"), []byte("name,salary\nada,99999"), 0o644))

	drv := &local.Driver{}
	require.NoError(t, drv.Init(context.Background(), map[string]any{"root": dir}))
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name: "main", Driver: "local", MountPath: "/data", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + strings.ReplaceAll(dir, `\`, `\\`) + `"}`),
	})
	require.NoError(t, err)

	localDrv := authlocal.New(store)
	require.NoError(t, localDrv.Init(context.Background(), nil))
	auth.SetEnabled([]auth.Driver{localDrv})

	cfg := config.Default()
	cfg.PublicURL = "http://test.local"
	cfg.CORS.AllowedOrigins = []string{"*"}
	// Without an encryption key the provider key cannot be sealed, and the
	// assistant refuses to store it — see internal/assistant/config.go.
	cfg.SecretKey = "assistant-tools-test-key"

	srv := httptest.NewServer(api.BuildRouter(&api.Deps{
		Cfg: cfg, Store: store, Worker: syncpkg.New(store), Caps: capability.New(store),
		Share: share.NewService(store), LocalAuth: localDrv,
		StorageResolver: func(id int64) (storage.Driver, error) {
			if id != st.ID {
				return nil, fmt.Errorf("unknown storage %d", id)
			}
			return drv, nil
		},
	}))
	t.Cleanup(srv.Close)

	client := freshClient(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)
	configureAssistant(t, srv, client, map[string]any{
		"enabled": true, "provider": "openai", "base_url": provider.srv.URL,
		"model": "test-model", "api_key": "sk-test",
	})
	return srv, client, store
}

// turnStream runs one turn and returns every event it produced.
func turnStream(t *testing.T, client *http.Client, url, prompt string) []map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"prompt": prompt})
	resp, err := client.Post(url, "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var events []map[string]any
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event map[string]any
		require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event))
		events = append(events, event)
	}
	return events
}

func eventsOfType(events []map[string]any, kind string) []map[string]any {
	var out []map[string]any
	for _, event := range events {
		if event["type"] == kind {
			out = append(out, event)
		}
	}
	return out
}

func answerText(events []map[string]any) string {
	var out strings.Builder
	for _, event := range eventsOfType(events, "text") {
		out.WriteString(event["delta"].(string))
	}
	return out.String()
}

func TestAssistantTools_LooksAtAFolderAndAnswersFromWhatItSaw(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "list_folder", map[string]any{"path": "main://notes"}),
		textFrame("There are two files in notes."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "what is in notes?")
	tools := eventsOfType(events, "tool")
	require.Len(t, tools, 1, "the panel is told what it is doing while it does it")
	assert.Equal(t, "list_folder", tools[0]["tool"])
	assert.Equal(t, "main://notes", tools[0]["target"])
	assert.Equal(t, "There are two files in notes.", answerText(events))

	// The second call carried the listing back to the model.
	sent := provider.sent()
	assert.Contains(t, sent, "hello.txt")
	assert.Contains(t, sent, "pay.csv")
	assert.Equal(t, 2, provider.rounds(), "one round to ask for the tool, one to answer")
}

// ⚠⚠ The rule the whole gate exists for: contents do not reach the model until
// the person approves THAT file, and approving one file approves one file.
func TestAssistantTools_ContentsNeedPermissionForThatExactFile(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "read_file", map[string]any{"path": "main://notes/pay.csv", "reason": "to summarise the salaries"}),
		textFrame("May I open pay.csv?"),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)
	turnURL := srv.URL + "/api/assistant/sessions/" + session + "/turn"

	events := turnStream(t, client, turnURL, "summarise the pay file")
	cards := eventsOfType(events, "card")
	require.Len(t, cards, 1, "the person is asked, in the panel")
	assert.Equal(t, "approval", cards[0]["kind"])
	assert.Equal(t, "main://notes/pay.csv", cards[0]["path"])
	assert.Equal(t, "to summarise the salaries", cards[0]["reason"], "the model's own reason, shown to the person deciding")
	assert.NotContains(t, provider.sent(), "99999", "the contents must not reach the model before consent")

	// The person approves that one file, and only then does it open.
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/approvals",
		map[string]any{"path": "main://notes/pay.csv"})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)

	provider.frames = []string{
		toolFrame("call_2", "read_file", map[string]any{"path": "main://notes/pay.csv", "reason": "to summarise the salaries"}),
		textFrame("Ada earns 99999."),
		// A different file in the same folder — one approval is not a licence.
		toolFrame("call_3", "read_file", map[string]any{"path": "main://notes/hello.txt", "reason": "checking the other one"}),
		textFrame("May I open hello.txt too?"),
	}
	provider.calls = 0
	provider.seen = nil

	events = turnStream(t, client, turnURL, "yes, go ahead")
	assert.Empty(t, eventsOfType(events, "card"), "an approved file needs no second permission")
	assert.Contains(t, provider.sent(), "99999", "now the contents are allowed through")

	events = turnStream(t, client, turnURL, "and the other file?")
	cards = eventsOfType(events, "card")
	require.Len(t, cards, 1, "the next file is asked for on its own")
	assert.Equal(t, "main://notes/hello.txt", cards[0]["path"])
	assert.NotContains(t, provider.sent(), "nothing secret here")

	// Reopening the conversation redraws what was asked and what was answered.
	st, raw = doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Granted  []string `json:"granted"`
		Messages []struct {
			Cards []struct {
				Path string `json:"path"`
			} `json:"cards"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	assert.Equal(t, []string{"main://notes/pay.csv"}, stored.Granted)
	var carded int
	for _, m := range stored.Messages {
		carded += len(m.Cards)
	}
	assert.Equal(t, 2, carded, "both approval requests survive a reload")
}

// A turn that keeps calling tools stops on its own and says so.
func TestAssistantTools_ToolLoopHasACeiling(t *testing.T) {
	frames := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		frames = append(frames, toolFrame(fmt.Sprintf("call_%d", i), "list_folder", map[string]any{"path": "main://notes"}))
	}
	provider := newScriptedProvider(t, frames...)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "go round in circles")
	assert.Contains(t, answerText(events), "I stopped after looking at too many things")
	assert.LessOrEqual(t, provider.rounds(), 8, "the round cap is what ends it, not the network")
}

// A tool that cannot do what was asked answers the model instead of failing the
// turn: the person gets a sentence, not a red line.
func TestAssistantTools_AMissingFolderIsAnAnswer(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "list_folder", map[string]any{"path": "main://nowhere"}),
		textFrame("There is no folder called nowhere."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "list nowhere")
	assert.Equal(t, "There is no folder called nowhere.", answerText(events))
	assert.Contains(t, provider.sent(), "error", "the failure was handed to the model to react to")
}
