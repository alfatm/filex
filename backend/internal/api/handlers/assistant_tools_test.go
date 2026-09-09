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
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
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
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/search/extract"
	"github.com/brf-tech/filex/backend/internal/share"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	syncpkg "github.com/brf-tech/filex/backend/internal/sync"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/trash"
	"github.com/brf-tech/filex/backend/internal/versioning"
)

// scriptedProvider answers each call with the next canned stream and records
// what it was sent, so a test can assert on what the model was shown.
//
// ⚠ Two kinds of call arrive here. A turn is one; naming the conversation
// afterwards is another, under its own prompt (assistant/title.go), and it is
// counted separately so a test about the tool loop is not measuring it.
type scriptedProvider struct {
	mu     sync.Mutex
	frames []string
	seen   []string
	calls  int
	titles int
	// titleFrame is what the naming call gets back. The default is a name, so
	// a test that does not care about naming still exercises the whole path.
	titleFrame string
	titleSeen  []string
	srv        *httptest.Server
}

// titleSystemPrompt is the opening of the naming prompt, which is how a
// recorded request says which kind of call it was.
const titleSystemPrompt = "You name conversations"

func newScriptedProvider(t *testing.T, frames ...string) *scriptedProvider {
	t.Helper()
	p := &scriptedProvider{frames: frames, titleFrame: textFrame("Looking around a folder")}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		p.mu.Lock()
		if strings.Contains(string(body), titleSystemPrompt) {
			p.titles++
			p.titleSeen = append(p.titleSeen, string(body))
			p.mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, p.titleFrame)
			fmt.Fprint(w, "data: [DONE]\n\n")
			w.(http.Flusher).Flush()
			return
		}
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

// rounds is how many times the model was asked to ANSWER — the naming call is
// not one of them.
func (p *scriptedProvider) rounds() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

// namings is how many times filex asked for a conversation name.
func (p *scriptedProvider) namings() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.titles
}

// nameRequests is everything the naming call was sent, whole — system prompt
// included, because what that call may see is the point of it.
func (p *scriptedProvider) nameRequests() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return strings.Join(p.titleSeen, "\n")
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

	// The node rows the bytes on disk correspond to. Everything that CHANGES a
	// file is addressed by node id — tags, versions, the trash — so a fixture
	// that only wrote files would exercise the read tools and nothing else.
	mk := func(clean string, kind model.NodeType, size int64, parent *int64) *model.Node {
		n, cerr := store.CreateNode(context.Background(), &model.Node{
			StorageID: st.ID, ParentID: parent, Name: path.Base(clean),
			Path: clean, PathHash: pathkey.Hash(st.ID, clean), Type: kind, Size: size,
		})
		require.NoError(t, cerr)
		return n
	}
	notes := mk("/notes", model.NodeTypeDirectory, 0, nil)
	mk("/notes/hello.txt", model.NodeTypeFile, 19, &notes.ID)
	mk("/notes/pay.csv", model.NodeTypeFile, 21, &notes.ID)

	localDrv := authlocal.New(store)
	require.NoError(t, localDrv.Init(context.Background(), nil))
	auth.SetEnabled([]auth.Driver{localDrv})

	cfg := config.Default()
	cfg.PublicURL = "http://test.local"
	cfg.CORS.AllowedOrigins = []string{"*"}
	// Without an encryption key the provider key cannot be sealed, and the
	// assistant refuses to store it — see internal/assistant/config.go.
	cfg.SecretKey = "assistant-tools-test-key"

	resolver := func(id int64) (storage.Driver, error) {
		if id != st.ID {
			return nil, fmt.Errorf("unknown storage %d", id)
		}
		return drv, nil
	}
	srv := httptest.NewServer(api.BuildRouter(&api.Deps{
		Cfg: cfg, Store: store, Worker: syncpkg.New(store), Caps: capability.New(store),
		Share: share.NewService(store), LocalAuth: localDrv, StorageResolver: resolver,
		// The services behind the operations that change something. Without
		// them the plan tools would report the feature as unavailable, which is
		// the right answer for a server that has none and the wrong one here.
		Versions: versioning.New(store, resolver),
		Trash:    trash.New(store, resolver, nil),
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
	return turnStreamWith(t, client, url, map[string]any{"prompt": prompt}, nil)
}

// turnStreamWith runs one turn with the given body and hands every event to
// `on` as it arrives — while the stream is still open, which is how a test
// answers a card the turn is waiting on.
func turnStreamWith(t *testing.T, client *http.Client, url string, body map[string]any, on func(map[string]any)) []map[string]any {
	t.Helper()
	raw, _ := json.Marshal(body)
	resp, err := client.Post(url, "application/json", strings.NewReader(string(raw)))
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
		if on != nil {
			on(event)
		}
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
//
// The permission is an interruption, not a conversation: the turn stands still
// at the card, the button answers it, and the same turn goes on — the model
// reads the contents (or a refusal) as the tool's result. Nothing is typed.
func TestAssistantTools_ContentsNeedPermissionForThatExactFile(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "read_file", map[string]any{"path": "main://notes/pay.csv", "reason": "to summarise the salaries"}),
		textFrame("Ada earns 99999."),
		// A different file in the same folder — one approval is not a licence.
		toolFrame("call_2", "read_file", map[string]any{"path": "main://notes/hello.txt", "reason": "checking the other one"}),
		textFrame("Fine without it."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)
	turnURL := srv.URL + "/api/assistant/sessions/" + session + "/turn"
	approvalsURL := srv.URL + "/api/assistant/sessions/" + session + "/approvals"

	// The card arrives with the stream still open; the person answers it from
	// another connection, and only then does the file open.
	answered := 0
	events := turnStreamWith(t, client, turnURL, map[string]any{"prompt": "summarise the pay file"}, func(event map[string]any) {
		if event["type"] != "card" || event["decision"] != nil {
			return
		}
		assert.Equal(t, "approval", event["kind"])
		assert.Equal(t, "main://notes/pay.csv", event["path"])
		assert.Equal(t, "to summarise the salaries", event["reason"], "the model's own reason, shown to the person deciding")
		assert.NotContains(t, provider.sent(), "99999", "the contents must not reach the model before consent")
		st, raw := doReq(t, client, http.MethodPost, approvalsURL, map[string]any{"path": "main://notes/pay.csv"})
		require.Equal(t, http.StatusOK, st, "approve: %s", raw)
		answered++
	})
	require.Equal(t, 1, answered, "the person was asked once: %v", events)
	cards := eventsOfType(events, "card")
	require.Len(t, cards, 2, "the card once to ask, once decided: %v", cards)
	assert.Nil(t, cards[0]["decision"])
	assert.Equal(t, "allowed", cards[1]["decision"], "the panel takes the buttons off it")
	assert.Equal(t, "Ada earns 99999.", answerText(events), "the same turn answered")
	assert.Contains(t, provider.sent(), "99999", "now the contents are allowed through")
	assert.Equal(t, 2, provider.rounds(), "one round to ask for the file, one to answer — no round for a typed permission")

	// The next file is asked for on its own, and a refusal is a tool result
	// the model goes on from, not a dead end.
	events = turnStreamWith(t, client, turnURL, map[string]any{"prompt": "and the other file?"}, func(event map[string]any) {
		if event["type"] != "card" || event["decision"] != nil {
			return
		}
		assert.Equal(t, "main://notes/hello.txt", event["path"])
		st, raw := doReq(t, client, http.MethodPost, approvalsURL, map[string]any{"path": "main://notes/hello.txt", "decision": "deny"})
		require.Equal(t, http.StatusOK, st, "deny: %s", raw)
	})
	cards = eventsOfType(events, "card")
	require.Len(t, cards, 2)
	assert.Equal(t, "denied", cards[1]["decision"])
	assert.Equal(t, "Fine without it.", answerText(events))
	assert.NotContains(t, provider.sent(), "nothing secret here")
	assert.Contains(t, provider.sent(), "did not allow", "the model is told, and told not to ask again")

	// Reopening the conversation redraws what was asked and how each ended.
	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Granted  []string `json:"granted"`
		Messages []struct {
			Cards []struct {
				Path     string `json:"path"`
				Decision string `json:"decision"`
			} `json:"cards"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	assert.Equal(t, []string{"main://notes/pay.csv"}, stored.Granted, "denying stores no grant")
	var decisions []string
	for _, m := range stored.Messages {
		for _, c := range m.Cards {
			decisions = append(decisions, c.Path+"="+c.Decision)
		}
	}
	assert.Equal(t, []string{"main://notes/pay.csv=allowed", "main://notes/hello.txt=denied"}, decisions)
}

// A PDF is read the way the search index reads it — through the extractor for
// its format — so the model gets the text and not the bytes.
func TestAssistantTools_ReadsAPDFThroughTheExtractor(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "read_file", map[string]any{"path": "main://notes/report.pdf", "reason": "to say what it is about"}),
		textFrame("It is about filex."),
	)
	srv, client, store := assistantFiles(t, provider)
	addFile(t, store, "/notes/report.pdf", minimalPDF("Quarterly revenue grew"))
	session := newSession(t, srv, client)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/approvals", map[string]any{"path": "main://notes/report.pdf"})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "what is the report about?")
	assert.Empty(t, eventsOfType(events, "card"), "approved beforehand, so nothing to ask")
	assert.Equal(t, "It is about filex.", answerText(events))
	// A tool result is a JSON string inside the request's JSON, hence the escaped quotes.
	sent := provider.sent()
	assert.Contains(t, sent, "Quarterly", "the text layer reached the model")
	assert.Contains(t, sent, `\"extracted_from\":\"application/pdf\"`)
	assert.NotContains(t, sent, "%PDF", "the bytes did not")
}

// Pictures have two tools of their own: view_image hands the model the picture
// (scaled, as JPEG), read_image_text hands it the words in it by OCR — and
// read_file, which is for text, sends the model to those two.
func TestAssistantTools_LooksAtAnImageAndReadsItsText(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "view_image", map[string]any{"path": "main://notes/logo.png", "reason": "to say what it shows"}),
		textFrame("A red rectangle."),
		toolFrame("call_2", "read_image_text", map[string]any{"path": "main://notes/logo.png", "reason": "to read the words on it"}),
		textFrame("No words."),
		toolFrame("call_3", "read_file", map[string]any{"path": "main://notes/logo.png", "reason": "trying the text tool"}),
		textFrame("Wrong tool."),
	)
	srv, client, store := assistantFiles(t, provider)
	addFile(t, store, "/notes/logo.png", redPNG(40, 30))
	session := newSession(t, srv, client)
	turnURL := srv.URL + "/api/assistant/sessions/" + session + "/turn"
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/approvals", map[string]any{"path": "main://notes/logo.png"})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)

	events := turnStream(t, client, turnURL, "what is in logo.png?")
	assert.Equal(t, "A red rectangle.", answerText(events))
	sent := provider.sent()
	assert.Contains(t, sent, `\"width\":40`, "the result names the picture's size")
	assert.Contains(t, sent, `"type":"image_url"`, "and the picture itself follows, for the model to see")
	assert.Contains(t, sent, `"url":"data:image/jpeg;base64,`, "re-encoded as JPEG, whatever it was")

	events = turnStream(t, client, turnURL, "any words on it?")
	assert.Equal(t, "No words.", answerText(events))
	sent = provider.sent()
	if extract.TesseractBin() == "" {
		assert.Contains(t, sent, "OCR is not installed on this server", "a missing tesseract is said, not disguised as an empty picture")
	} else {
		assert.Contains(t, sent, "view_image lets you look at", "a picture with no words points at the other tool")
	}

	events = turnStream(t, client, turnURL, "read it as text then")
	assert.Equal(t, "Wrong tool.", answerText(events))
	assert.Contains(t, provider.sent(), "is an image: read_image_text extracts the text in it, view_image lets you look at it")
}

// redPNG is a w×h solid red picture.
func redPNG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 220, A: 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// The chip binds the search rather than advising the model: on Tags every
// term is a tag, on Filename contents are not consulted.
func TestAssistantTools_TheChipBindsTheSearch(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "search_files", map[string]any{"path": "main://", "query": "payroll"}),
		textFrame("One tagged file."),
		toolFrame("call_2", "search_files", map[string]any{"path": "main://", "query": "payroll"}),
		textFrame("Nothing by that name."),
	)
	srv, client, store := assistantFiles(t, provider)
	tagFile(t, store, "/notes/pay.csv", "payroll")
	session := newSession(t, srv, client)
	turnURL := srv.URL + "/api/assistant/sessions/" + session + "/turn"

	events := turnStreamWith(t, client, turnURL, map[string]any{"prompt": "payroll", "mode": "tags"}, nil)
	hits := eventsOfType(events, "hits")
	require.Len(t, hits, 1, "%v", events)
	rows, _ := hits[0]["hits"].([]any)
	require.Len(t, rows, 1, "the tagged file, found by its tag: %v", rows)
	assert.Contains(t, provider.sent(), `\"query\":\"tag:payroll\"`, "the word became a tag")
	assert.Contains(t, provider.sent(), `\"scope\":\"tags\"`, "and the model is told which scope answered")

	events = turnStreamWith(t, client, turnURL, map[string]any{"prompt": "payroll", "mode": "filename"}, nil)
	hits = eventsOfType(events, "hits")
	require.Len(t, hits, 1)
	rows, _ = hits[0]["hits"].([]any)
	assert.Empty(t, rows, "no file is NAMED payroll")
}

// addFile puts one more file into the fixture's storage: on disk, and as the
// node row the read path resolves it through.
func addFile(t *testing.T, store db.Store, clean string, body []byte) {
	t.Helper()
	ctx := context.Background()
	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)
	require.Len(t, storages, 1)
	st := storages[0]
	var cfg struct {
		Root string `json:"root"`
	}
	require.NoError(t, json.Unmarshal(st.ConfigJSON, &cfg))
	require.NoError(t, os.WriteFile(filepath.Join(cfg.Root, filepath.FromSlash(clean)), body, 0o644))
	parent, err := store.GetNodeByPath(ctx, st.ID, pathkey.Hash(st.ID, path.Dir(clean)))
	require.NoError(t, err)
	_, err = store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, ParentID: &parent.ID, Name: path.Base(clean),
		Path: clean, PathHash: pathkey.Hash(st.ID, clean), Type: model.NodeTypeFile, Size: int64(len(body)),
	})
	require.NoError(t, err)
}

func tagFile(t *testing.T, store db.Store, clean string, tags ...string) {
	t.Helper()
	ctx := context.Background()
	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)
	node, err := store.GetNodeByPath(ctx, storages[0].ID, pathkey.Hash(storages[0].ID, clean))
	require.NoError(t, err)
	require.NoError(t, store.SetNodeTags(ctx, node.ID, tags))
}

// minimalPDF is a one-page PDF with `text` in its text layer — the same shape
// the extractor's own tests build.
func minimalPDF(text string) []byte {
	stream := fmt.Sprintf("BT /F1 12 Tf 72 720 Td (%s) Tj ET", text)
	objs := []string{
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
		fmt.Sprintf("4 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n", len(stream), stream),
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	}
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs)+1)
	for i, o := range objs {
		offsets[i+1] = buf.Len()
		buf.WriteString(o)
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n", len(objs)+1)
	buf.WriteString("0000000000 65535 f \n")
	for i := 1; i <= len(objs); i++ {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offsets[i])
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return buf.Bytes()
}

// A turn that keeps calling tools stops on its own and says so.
// A search gives the person something to look at, not only something for the
// model to describe: the rows come down the stream as they are found, and they
// are still there when the conversation is reopened.
func TestAssistantTools_SearchSendsTheRowsToTheInterface(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "search_files", map[string]any{"path": "main://", "query": "hello"}),
		textFrame("I found one."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "find hello")
	hits := eventsOfType(events, "hits")
	require.Len(t, hits, 1, "one search, one batch of rows: %v", events)
	rows, _ := hits[0]["hits"].([]any)
	require.NotEmpty(t, rows)
	first, _ := rows[0].(map[string]any)
	assert.Contains(t, first["path"], "hello.txt")
	assert.Equal(t, "file", first["type"], "the panel draws an icon from this")

	// ⚠ Reopening the conversation redraws them. An answer that pointed at a
	// file is half missing without the row it pointed at.
	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Messages []struct {
			Hits []map[string]any `json:"hits"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	var seen int
	for _, m := range stored.Messages {
		seen += len(m.Hits)
	}
	assert.Equal(t, len(rows), seen, "every row shown during the turn is still there")
}

// A long list goes to the person as a report card, not as prose: the rows are
// resolved to current metadata, a path the model made up is reported back to
// it as missing rather than written into the document, and the card is stored
// with the answer so a reopened conversation still has it to download.
func TestAssistantTools_ReportGoesToTheInterfaceAndIsStored(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "write_report", map[string]any{
			"title": "Notes", "text": "Everything in notes.",
			"paths": []string{"main://notes/hello.txt", "main://notes/pay.csv", "main://notes/nope.txt"},
		}),
		textFrame("The list is in the report."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "list my notes")
	reports := eventsOfType(events, "report")
	require.Len(t, reports, 1, "%v", events)
	report, _ := reports[0]["report"].(map[string]any)
	assert.Equal(t, "Notes", report["title"])
	assert.Equal(t, "Everything in notes.", report["text"])
	rows, _ := report["rows"].([]any)
	require.Len(t, rows, 2, "the path that does not exist is not a row")
	first, _ := rows[0].(map[string]any)
	assert.Equal(t, "main://notes/hello.txt", first["path"])
	assert.Equal(t, "hello.txt", first["name"])
	assert.Equal(t, "file", first["type"])
	assert.EqualValues(t, 19, first["size"], "the row is the file as it is, not as the model said")

	// The model is told which path went nowhere, so it can say so.
	sent := provider.sent()
	assert.Contains(t, sent, `\"missing\":[\"main://notes/nope.txt\"]`)
	assert.Contains(t, sent, `\"rows\":2`)

	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Messages []struct {
			Reports []map[string]any `json:"reports"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	var seen []map[string]any
	for _, m := range stored.Messages {
		seen = append(seen, m.Reports...)
	}
	require.Len(t, seen, 1)
	assert.Equal(t, "Notes", seen[0]["title"])
	assert.Len(t, seen[0]["rows"], 2)
}

// A report with neither text nor paths is refused as an answer the model has
// to read, not as a failed turn.
func TestAssistantTools_ReportNeedsSomethingToReport(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "write_report", map[string]any{"title": "Empty"}),
		textFrame("Nothing to report."),
	)
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "make an empty report")
	assert.Empty(t, eventsOfType(events, "report"))
	assert.Contains(t, provider.sent(), "a report needs paths, text, or both")
}

// The scope chip is a hint for the turn it was set on: it reaches the model,
// and it does not become part of the stored conversation.
func TestAssistantTurn_ScopeChipIsSentButNotStored(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("Looked at names."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	body, _ := json.Marshal(map[string]string{"prompt": "find the invoice", "mode": "content"})
	resp, err := client.Post(srv.URL+"/api/assistant/sessions/"+session+"/turn", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()

	sent := provider.sent()
	assert.Contains(t, sent, "find the invoice")
	assert.Contains(t, sent, "look inside file contents", "the chip reached the model as a scope hint")

	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	assert.Equal(t, "find the invoice", stored.Messages[0].Content, "what the person typed is what is kept")
}

// An unknown chip is ignored rather than refused: a hint is not worth a 400.
func TestAssistantTurn_AnUnknownScopeIsIgnored(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("Fine."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	body, _ := json.Marshal(map[string]string{"prompt": "hello", "mode": "nonsense"})
	resp, err := client.Post(srv.URL+"/api/assistant/sessions/"+session+"/turn", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.NotContains(t, provider.sent(), "Scope chosen in the interface")
}

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

// What the person has on screen reaches the model with the question and is
// not stored with it: the next question is asked from wherever they are then.
func TestAssistantTurn_ScreenContextIsSentButNotStored(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("Those two."), textFrame("Fine."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	ask := func(body map[string]any) {
		raw, _ := json.Marshal(body)
		resp, err := client.Post(srv.URL+"/api/assistant/sessions/"+session+"/turn", "application/json", strings.NewReader(string(raw)))
		require.NoError(t, err)
		_, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	ask(map[string]any{"prompt": "what are these?", "context": map[string]any{
		"page": "folder", "folder": "main://notes",
		"selected": []string{"main://notes/hello.txt", "main://notes/pay.csv"}, "selectedTotal": 7,
	}})
	sent := provider.sent()
	assert.Contains(t, sent, "what are these?")
	assert.Contains(t, sent, "Open folder: main://notes")
	assert.Contains(t, sent, "Selected (7): main://notes/hello.txt, main://notes/pay.csv … and 5 more")

	// A page the assistant has no words for carries nothing.
	ask(map[string]any{"prompt": "and now?", "context": map[string]any{"page": "settings", "selected": []string{"main://notes/pay.csv"}}})
	last := provider.sent()[len(sent):]
	assert.Contains(t, last, "and now?")
	assert.NotContains(t, last, "on screen right now")

	st, raw := doReq(t, client, http.MethodGet, srv.URL+"/api/assistant/sessions/"+session, nil)
	require.Equal(t, http.StatusOK, st)
	var stored struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(raw, &stored))
	assert.Equal(t, "what are these?", stored.Messages[0].Content, "what the person typed is what is kept")
}

// The search page: the query, the settings, the count and the first hits.
func TestAssistantTurn_SearchPageContextNamesTheSearch(t *testing.T) {
	provider := newScriptedProvider(t, textFrame("Both invoices."))
	srv, client, _ := assistantFiles(t, provider)
	session := newSession(t, srv, client)

	raw, _ := json.Marshal(map[string]any{"prompt": "which is newer?", "context": map[string]any{
		"page": "search",
		"search": map[string]any{
			"query": "invoice", "filters": []string{"type: documents", "modified: week"},
			"total": 120, "capped": true, "hits": []string{"main://notes/hello.txt", "main://notes/pay.csv"},
		},
	}})
	resp, err := client.Post(srv.URL+"/api/assistant/sessions/"+session+"/turn", "application/json", strings.NewReader(string(raw)))
	require.NoError(t, err)
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()

	sent := provider.sent()
	assert.Contains(t, sent, `Search: query \"invoice\"; settings: type: documents; modified: week; more than 120 results; the first results shown: main://notes/hello.txt, main://notes/pay.csv`)
}

// ⚠⚠ A picture is refused on its DECLARED size, before it is decoded.
//
// image.Decode builds the whole uncompressed frame first and scales it
// afterwards, and compression makes the file size say nothing about that
// frame: a PNG well under the 8 MiB a read is capped at can declare a canvas
// of tens of thousands of pixels a side and cost gigabytes to open. Any
// account could put one in its own drive and ask the assistant to look at it.
func TestAssistantTools_ViewImageRefusesAPictureTooLargeToDecode(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "view_image", map[string]any{"path": "main://notes/bomb.png", "reason": "to say what it shows"}),
		textFrame("It is too large to look at."),
	)
	srv, client, store := assistantFiles(t, provider)
	bomb := declaredSizePNG(t, 8000, 6000)
	assert.Less(t, len(bomb), 1024, "the whole point is that the file is tiny and the frame is not")
	addFile(t, store, "/notes/bomb.png", bomb)
	session := newSession(t, srv, client)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/approvals", map[string]any{"path": "main://notes/bomb.png"})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "what is in bomb.png?")
	// A tool result the model reads and relays, not a failed request.
	assert.Empty(t, eventsOfType(events, "error"))
	assert.Equal(t, "It is too large to look at.", answerText(events))
	sent := provider.sent()
	assert.Contains(t, sent, "8000×6000", "the refusal names the size it read out of the header")
	assert.Contains(t, sent, "past the 40 megapixels this can open")
	assert.NotContains(t, sent, `"type":"image_url"`, "and nothing was decoded, so nothing was attached")
}

// declaredSizePNG builds a PNG whose HEADER claims w×h while its data is one
// pixel. Only the IHDR is patched, which is the whole trick being defended
// against: the size a decoder allocates for is the size the file CLAIMS.
func declaredSizePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1))))
	raw := buf.Bytes()
	// 8 bytes of signature, then the IHDR chunk: 4 length, 4 type, then width
	// and height, and a CRC over type+data at the end of its 13 data bytes.
	require.Greater(t, len(raw), 33)
	binary.BigEndian.PutUint32(raw[16:20], uint32(w))
	binary.BigEndian.PutUint32(raw[20:24], uint32(h))
	binary.BigEndian.PutUint32(raw[29:33], crc32.ChecksumIEEE(raw[12:29]))
	return raw
}

// A file whose NAME contains one of filex's bucket names as a substring.
//
// aiOps.List — the chokepoint every assistant listing goes through — dropped
// entries with `strings.Contains(path, ".thumbs")`, so `my.thumbsup.png` never
// reached the model and nothing said it had been dropped: the person asks about
// a file that is right there and is told it does not exist. The listing tools
// already test whole components (model.IsReservedPath); this is the layer under
// them, which did not.
func TestAssistantTools_ListsAFileNamedLikeOneOfFilexsOwnBuckets(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "list_folder", map[string]any{"path": "main://notes"}),
		textFrame("There are three files in notes."),
	)
	srv, client, store := assistantFiles(t, provider)
	ctx := context.Background()

	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, storages)
	var cfg struct {
		Root string `json:"root"`
	}
	require.NoError(t, json.Unmarshal(storages[0].ConfigJSON, &cfg))
	require.NoError(t, os.WriteFile(filepath.Join(cfg.Root, "notes", "my.thumbsup.png"), []byte("not a bucket"), 0o644))
	// And the real bucket beside it, so this is not "the filter was removed".
	require.NoError(t, os.MkdirAll(filepath.Join(cfg.Root, "notes", ".thumbs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(cfg.Root, "notes", ".thumbs", "cache.jpg"), []byte("x"), 0o644))

	session := newSession(t, srv, client)
	turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "what is in notes?")

	sent := provider.sent()
	assert.Contains(t, sent, "my.thumbsup.png", "a person's file is not one of filex's buckets")
	assert.NotContains(t, sent, ".thumbs\\\"", "the bucket itself stays hidden")
	assert.NotContains(t, sent, "cache.jpg")
}
