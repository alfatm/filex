// Package handlers — assistant_turn.go
//
//	GET  /api/assistant/status                    (auth)  is there an assistant
//	POST /api/assistant/sessions/{id}/turn        (auth)  ask, streamed back
//
// # Why the turn is a stream and not a request
//
// A model answers at reading speed, over tens of seconds. A single JSON
// response would show the person a spinner for all of it and then everything at
// once, and — this is the part that matters — there would be no way to stop it
// half-way. Streaming is what makes the stop button real: the client closes the
// connection, the request context cancels, and the provider call ends where it
// stood.
//
// # What survives a stop
//
// Whatever was written stays. The question is stored BEFORE the model is
// called, so a connection that dies loses no part of the conversation, and the
// partial answer is stored when the stream ends however it ended — marked as
// stopped, not deleted. Somebody who pressed stop had read the beginning and
// usually wanted it; deleting it to keep the log tidy would throw away the only
// thing they got.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
)

// maxPromptBytes bounds one question. Generous for anything typed, small
// enough that a client cannot push a file's worth of text through the model on
// the operator's bill. It is also the ceiling on the assistant's other request
// bodies — a title, a path, a decision — which are far smaller still: a bound
// that is loose for all of them is better than the three that were unbounded.
const maxPromptBytes = 32 * 1024

// AttachAI wires the model side. Without it the status endpoint reports no
// assistant and the turn route answers 503 — which is the correct answer for
// an installation that has not configured one.
func (h *Assistant) AttachAI(svc *assistant.Service) { h.AI = svc }

// AttachTools wires the file surface the assistant may look at. Without it the
// model has no tools and says so — see the prompt's closing section.
func (h *Assistant) AttachTools(deps AssistantToolDeps) { h.Tools = &deps }

// Status tells the client whether asking is possible at all. The panel is
// drawn from this, so an installation with no provider never offers a chat box
// that could only fail.
//
// It reports no endpoint, no key and no problem text: those are the operator's
// business, and this route is reachable by every account.
func (h *Assistant) Status(w http.ResponseWriter, r *http.Request) {
	if h.AI == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	cfg := h.AI.Config(r.Context())
	out := map[string]any{"enabled": cfg.Ready()}
	if cfg.Ready() {
		out["model"] = cfg.Model
	}
	writeJSON(w, http.StatusOK, out)
}

type turnReq struct {
	Prompt string `json:"prompt"`
	// Mode is the scope chip the person had selected: "filename", "content" or
	// "tags". Anything else is ignored rather than refused — it is a hint, and
	// a turn is worth more than a 400 over a chip.
	Mode string `json:"mode"`
	// Screen is what the person was looking at when they asked. Like the
	// chip, it is a hint for this turn and nothing about it is refused.
	Screen *screenContext `json:"context"`
}

// screenContext is the page the question was asked from, as the interface
// describes it: which page, the folder that is open, the rows selected, the
// search on screen. "These files" and "this folder" are only answerable with
// it — the model cannot see the window.
//
// ⚠ It is a hint, not a listing and not a permission. The open folder's
// contents are not carried (list_folder is), and the addresses here grant
// nothing: every tool still checks the person's access on its own.
type screenContext struct {
	// Page is "folder", "search", "recent", "starred", "shared", "trash" or
	// "home". Anything else means the interface is somewhere the assistant
	// has no words for, and the context is dropped whole.
	Page string `json:"page"`
	// Folder is the open folder's address on the folder page.
	Folder string `json:"folder,omitempty"`
	// Selected is the addresses of the selected rows, in listing order — the
	// first of them; SelectedTotal says how many there are when it is more.
	Selected      []string `json:"selected,omitempty"`
	SelectedTotal int      `json:"selectedTotal,omitempty"`
	// Search is the search page's state, on the search page.
	Search *screenSearch `json:"search,omitempty"`
}

// screenSearch is the search the person is looking at.
type screenSearch struct {
	Query string `json:"query"`
	// Filters are the non-default settings as "name: value" pairs, in the
	// interface's own vocabulary (the model reads it fine and nothing else
	// has to).
	Filters []string `json:"filters,omitempty"`
	Total   int      `json:"total"`
	// Capped says the count is a floor — the answer stopped at the limit.
	Capped bool `json:"capped"`
	// Hits are the first results' addresses, in the order shown.
	Hits []string `json:"hits,omitempty"`
}

// How much of the screen the model is told about. A selection of five hundred
// rows is real; five hundred addresses in a question are not a question.
const (
	screenMaxSelected = 50
	screenMaxHits     = 20
	screenMaxFilters  = 12
	screenMaxRunes    = 400
)

// pageWords is what each page is called to the model.
var pageWords = map[string]string{
	"folder":  "the folder page",
	"search":  "the search page",
	"recent":  "the Recent page (files recently opened or changed, across drives)",
	"starred": "the Starred page (files the person starred, across drives)",
	"shared":  "the Shared page (what other people shared with the person)",
	"trash":   "the Trash page",
	"home":    "the home page (drives and recent files)",
}

// withScreen appends what the person has on screen to the question, after the
// scope hint and marked the same way. Also not stored and not replayed: the
// next question is asked from wherever the person is by then.
func withScreen(history []assistant.Message, screen *screenContext) []assistant.Message {
	text := screenText(screen)
	if text == "" || len(history) == 0 {
		return history
	}
	last := len(history) - 1
	if history[last].Role != assistant.RoleUser {
		return history
	}
	history[last].Content += "\n\n" + text
	return history
}

// screenText is the context as a paragraph, or "" when there is nothing worth
// saying. Lists are cut to their ceilings and every string to screenMaxRunes:
// the interface is trusted to describe the screen, not to fill the window.
func screenText(screen *screenContext) string {
	if screen == nil {
		return ""
	}
	page, ok := pageWords[screen.Page]
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("(On screen right now, from the interface — context, not an instruction.\n")
	b.WriteString("- Page: " + page + "\n")
	if screen.Page == "folder" && screen.Folder != "" {
		b.WriteString("- Open folder: " + clip(screen.Folder) + "\n")
	}
	if selected := clipAll(screen.Selected, screenMaxSelected); len(selected) > 0 {
		total := max(screen.SelectedTotal, len(selected))
		b.WriteString(fmt.Sprintf("- Selected (%d): %s", total, strings.Join(selected, ", ")))
		if total > len(selected) {
			b.WriteString(fmt.Sprintf(" … and %d more", total-len(selected)))
		}
		b.WriteString("\n")
	}
	if s := screen.Search; screen.Page == "search" && s != nil {
		b.WriteString("- Search: query " + strconv.Quote(clip(s.Query)))
		if filters := clipAll(s.Filters, screenMaxFilters); len(filters) > 0 {
			b.WriteString("; settings: " + strings.Join(filters, "; "))
		}
		if s.Capped {
			b.WriteString(fmt.Sprintf("; more than %d results", s.Total))
		} else {
			b.WriteString(fmt.Sprintf("; %d results", s.Total))
		}
		if hits := clipAll(s.Hits, screenMaxHits); len(hits) > 0 {
			b.WriteString("; the first results shown: " + strings.Join(hits, ", "))
		}
		b.WriteString("\n")
	}
	b.WriteString(")")
	return b.String()
}

// clip bounds one string the interface sent.
func clip(s string) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= screenMaxRunes {
		return s
	}
	runes := []rune(s)
	return string(runes[:screenMaxRunes]) + "…"
}

// clipAll bounds a list: at most n entries, blanks dropped, each clipped.
func clipAll(list []string, n int) []string {
	out := make([]string, 0, min(len(list), n))
	for _, s := range list {
		if len(out) == n {
			break
		}
		if s = clip(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// scopeHints turn the panel's chips into a sentence the model can act on. They
// are NOT stored with the question and not replayed: the chip belongs to the
// turn it was set for, the same way it does on screen.
var scopeHints = map[string]string{
	"filename": "For this question, search_files matches file and folder NAMES only; contents are not consulted.",
	"content":  "For this question, search_files will look inside file contents where filex has indexed them, as well as at names.",
	"tags":     "For this question, search_files reads every term as a TAG — `design` means `tag:design` — and finds tagged files, not names.",
}

// withScope appends the chip's hint to the question the model is about to be
// asked, marked so the model can tell it from the person's own words.
func withScope(history []assistant.Message, mode string) []assistant.Message {
	hint := scopeHints[mode]
	if hint == "" || len(history) == 0 {
		return history
	}
	last := len(history) - 1
	if history[last].Role != assistant.RoleUser {
		return history
	}
	history[last].Content += "\n\n(Scope chosen in the interface: " + hint + ")"
	return history
}

// The two ways a turn is refused before it starts. They ride in the 429's
// `code`, the same field name and the same flat vocabulary the error frame
// uses for "quota" and "unavailable", so the panel has one thing to read.
const (
	// turnCodeBusy: this account already has a turn streaming — usually the
	// person's own other tab. It clears itself when that one ends.
	turnCodeBusy = "busy"
	// turnCodeRateLimited: the per-minute ceiling. Waiting is the whole fix.
	turnCodeRateLimited = "rate_limited"
)

// turnRefusalCode names the refusal, or "" for one that has no name yet —
// anything unclassified stays generic rather than being labelled as the wrong
// one of the two.
func turnRefusalCode(err error) string {
	switch {
	case errors.Is(err, assistant.ErrBusy):
		return turnCodeBusy
	case errors.Is(err, assistant.ErrRateLimited):
		return turnCodeRateLimited
	}
	return ""
}

// Turn asks the model and streams the answer back as server-sent events:
//
//	{"type":"meta","conversation_id":"7"}   once, first
//	{"type":"tool","tool":"…","target":"…"} while a tool runs
//	{"type":"text","delta":"…"}             repeatedly
//	{"type":"card","kind":"approval"|"plan",…}  something for the person to decide
//	{"type":"title","title":"…"}            once, when a conversation is named
//	{"type":"error","message":"…","code":"…"} at most once, instead of the rest
//	{"type":"done"}                         once, last
//
// `code` is present only when the failure is one the person can act on:
// "quota" (the provider account is out of credit) or "unavailable" (the
// assistant was switched off or its provider no longer answers for it).
//
// The events carry their type in the data payload rather than in an SSE
// `event:` line so the client has one parser and one switch.
func (h *Assistant) Turn(w http.ResponseWriter, r *http.Request) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	user := auth.UserFrom(r.Context())
	if h.AI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no assistant is configured"})
		return
	}
	var req turnReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPromptBytes)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty prompt"})
		return
	}
	cfg := h.AI.Config(r.Context())
	if !cfg.Ready() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no assistant is configured"})
		return
	}
	release, err := h.AI.Begin(user.ID, cfg.TurnsPerMinute)
	if err != nil {
		// 429 for both, but not the same thing to the person: one means their
		// own other tab is mid-answer, the other means this account has asked
		// too often in the last minute. The code is what the panel branches on
		// — the sentence beside it is English prose and matching against it
		// would break on the day it is reworded.
		refusal := map[string]string{"error": err.Error()}
		if code := turnRefusalCode(err); code != "" {
			refusal["code"] = code
		}
		writeJSON(w, http.StatusTooManyRequests, refusal)
		return
	}
	defer release()

	// Stored before the model is called: a question the person asked is part of
	// the conversation whether or not it gets an answer.
	if _, err := h.Store.AppendAssistantMessage(r.Context(), &model.AssistantMessage{
		SessionID: session.ID,
		Role:      model.AssistantRoleUser,
		Content:   prompt,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	history, err := h.history(r, session.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// ⚠ ResponseController, not a type assertion on http.Flusher. The router's
	// logging middleware wraps every writer to record the status code, and the
	// wrapper is not itself a Flusher — asserting for one here answered "this
	// server cannot stream" on a server that streams fine. The controller
	// follows the Unwrap chain the wrapper already implements.
	stream := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// The answer is assembled by the client as it arrives; a proxy that buffers
	// it would turn the stream back into one slow response.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// ⚠ The keepalive writes from a goroutine of its own, so every write to the
	// stream goes through this lock — two writers interleaving would tear a
	// frame in half.
	var writing sync.Mutex
	send := func(event map[string]any) error {
		payload, err := json.Marshal(event)
		if err != nil {
			return err
		}
		writing.Lock()
		defer writing.Unlock()
		if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
			return err
		}
		return stream.Flush()
	}
	defer startKeepalive(r.Context(), w, stream, &writing)()
	_ = send(map[string]any{"type": "meta", "conversation_id": strconv.FormatInt(session.ID, 10)})

	// The toolbox is built per turn: the session id is half of every permission
	// question read_file asks.
	var answer strings.Builder
	// Cards outlive the stream: a conversation reopened tomorrow has to show
	// the same approval and how it ended, so they are stored with the answer.
	// So do the search results — an answer that pointed at four files is half
	// missing without them.
	var cards []assistant.Card
	var hits []json.RawMessage
	var reports []json.RawMessage
	var box assistant.Toolbox
	if h.Tools != nil {
		tools := newAssistantTools(*h.Tools, session.ID)
		tools.mode = req.Mode
		// The read gate's question, asked as an interruption: the card goes
		// out, the turn stands still until the button is pressed, and the
		// tool call returns with the answer. Nothing about it goes through
		// the chat — the model reads contents or a refusal, the same as any
		// other tool result, and the person types nothing.
		tools.ask = func(ctx context.Context, card assistant.Card) string {
			// ⚠ The waiter is registered BEFORE the card goes out, and the
			// registration is dropped however this returns. Sending first left
			// a gap: a person who pressed Allow inside it found no waiter to
			// hand the decision to, and the turn then stood still for the full
			// approvalWait before telling the model the request had expired.
			answer := h.desk.expect(session.ID, card.Path)
			defer h.desk.forget(session.ID, card.Path)
			_ = send(cardEvent(card))
			card.Decision = assistant.DecisionExpired
			select {
			case card.Decision = <-answer:
			case <-ctx.Done():
			case <-time.After(approvalWait):
			}
			cards = append(cards, card)
			// The same card again, decided: the panel takes the buttons off it.
			_ = send(cardEvent(card))
			return card.Decision
		}
		box = tools
	}
	askErr := h.AI.Ask(r.Context(), cfg, box, withScreen(withScope(history, req.Mode), req.Screen), func(event assistant.Event) error {
		switch event.Type {
		case assistant.EventText:
			answer.WriteString(event.Delta)
			return send(map[string]any{"type": "text", "delta": event.Delta})
		case assistant.EventTool:
			// What it is doing, while it does it. A panel that shows nothing
			// for twenty seconds of tool calls looks stuck.
			return send(map[string]any{"type": "tool", "tool": event.Tool, "target": toolTarget(event.Args)})
		case assistant.EventHits:
			// Straight through: the rows were built by the tool and are read by
			// the panel, and re-shaping them here would only add a third
			// spelling of a file row.
			hits = append(hits, event.Hits)
			return send(map[string]any{"type": "hits", "hits": json.RawMessage(event.Hits)})
		case assistant.EventReport:
			reports = append(reports, event.Report)
			return send(map[string]any{"type": "report", "report": json.RawMessage(event.Report)})
		case assistant.EventCard:
			if event.Card == nil {
				return nil
			}
			cards = append(cards, *event.Card)
			return send(cardEvent(*event.Card))
		}
		return nil
	})

	// ⚠ Persisted on a context of its own. r.Context() is already cancelled in
	// exactly the case this matters most — the person pressed stop — and
	// writing through it would drop the words they had already read.
	stopped := r.Context().Err() != nil
	h.persistAnswer(r, session.ID, answer.String(), stopped, cards, hits, reports)

	if askErr != nil {
		failure := map[string]any{"type": "error", "message": askErr.Error()}
		if errors.Is(askErr, assistant.ErrNotConfigured) {
			failure["message"] = "no assistant is configured"
		}
		if code := assistant.ErrorCode(askErr); code != "" {
			failure["code"] = code
		}
		_ = send(failure)
	}
	if askErr == nil && !stopped {
		if title := h.nameSession(r, cfg, session, prompt); title != "" {
			_ = send(map[string]any{"type": "title", "title": title})
		}
	}
	_ = send(map[string]any{"type": "done"})
}

// keepaliveInterval is how often a turn that is producing nothing says the
// connection is still alive.
//
// A turn stands still for minutes on purpose: a read request waits up to
// approvalWait for a button, an OCR or a large PDF takes its time, and a model
// can be slow to its first token. Both ends of the connection treat silence as
// death long before that — a reverse proxy's default proxy_read_timeout is 60s
// and the panel's own silence watchdog is the same — so the ceiling here is
// well under a minute, and low enough that one missed tick is still not a
// timeout.
//
// ⚠ A var only so a test can shorten it; nothing writes it at run time.
var keepaliveInterval = 15 * time.Second

// startKeepalive writes an SSE COMMENT down the stream at that interval, and
// returns the function that stops it.
//
// A comment rather than a new frame type: the client already drops comment
// lines, so nothing has to learn a word for "still here", the stored answer
// cannot be polluted by something that is never parsed, and a stop is
// unaffected — the ping carries no meaning to lose.
func startKeepalive(ctx context.Context, w http.ResponseWriter, stream *http.ResponseController, writing *sync.Mutex) func() {
	stop, stopped := make(chan struct{}), make(chan struct{})
	ticker := time.NewTicker(keepaliveInterval)
	go func() {
		defer close(stopped)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				writing.Lock()
				if _, err := fmt.Fprint(w, ": keepalive\n\n"); err == nil {
					_ = stream.Flush()
				}
				writing.Unlock()
			}
		}
	}()
	return func() {
		close(stop)
		// ⚠ Waited for, not merely signalled. A write to the ResponseWriter
		// after the handler has returned races with the server recycling it.
		<-stopped
	}
}

// history replays the conversation for the model, oldest first.
func (h *Assistant) history(r *http.Request, sessionID int64) ([]assistant.Message, error) {
	rows, err := h.Store.ListAssistantMessages(r.Context(), sessionID)
	if err != nil {
		return nil, err
	}
	out := make([]assistant.Message, 0, len(rows))
	for _, m := range rows {
		out = append(out, assistant.Message{Role: m.Role, Content: m.Content})
	}
	return out, nil
}

// persistAnswer stores what the model produced, if anything.
//
// An answer that never started is not stored: an empty assistant row would
// draw an empty bubble in the panel and would be replayed to the model as a
// turn it did not take.
func (h *Assistant) persistAnswer(r *http.Request, sessionID int64, text string, stopped bool, cards []assistant.Card, hits, reports []json.RawMessage) {
	if strings.TrimSpace(text) == "" && len(cards) == 0 && len(hits) == 0 && len(reports) == 0 {
		return
	}
	ctx := context.WithoutCancel(r.Context())
	if _, err := h.Store.AppendAssistantMessage(ctx, &model.AssistantMessage{
		SessionID:   sessionID,
		Role:        model.AssistantRoleAssistant,
		Content:     text,
		PayloadJSON: turnPayload(cards, hits, reports),
		Aborted:     stopped,
	}); err != nil {
		slog.Error("assistant: storing the answer failed", slog.Any("error", err), slog.Int64("session", sessionID))
	}
}

// nameSession gives an unnamed conversation a name, once it has something to
// be named after. It returns the title it stored, or "" — including whenever
// anything at all went wrong, because a conversation without a name is a small
// thing and a failed turn would not be.
//
// ⚠ A title somebody typed is never touched. TitleManual is what says so, and
// it is the reason the generator cannot quietly rename a conversation the
// person has already named.
func (h *Assistant) nameSession(r *http.Request, cfg assistant.Config, session *model.AssistantSession, question string) string {
	if session.Title != "" || session.TitleManual {
		return ""
	}
	// Its own context: the naming call outlives nothing, but the request's
	// context is the one thing that may already be on its way out.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), titleTimeout)
	defer cancel()
	title, err := h.AI.Title(ctx, cfg, question)
	if err != nil || title == "" {
		if err != nil {
			slog.Debug("assistant: naming the conversation failed", slog.Any("error", err), slog.Int64("session", session.ID))
		}
		return ""
	}
	title = clampTitle(title)
	if err := h.Store.SetAssistantSessionTitle(ctx, session.ID, title, false); err != nil {
		slog.Error("assistant: storing the conversation name failed", slog.Any("error", err), slog.Int64("session", session.ID))
		return ""
	}
	return title
}

// titleTimeout bounds the naming call. It happens after the person has their
// answer, so it may fail quietly, but it must not hold the connection open.
const titleTimeout = 30 * time.Second

// toolTarget is the one word of a tool call worth showing a person while it
// runs: the path being listed, or the words being searched for. It reads the
// model's raw arguments, which may be anything, so it never fails — an
// unreadable call simply shows the tool's name alone.
func toolTarget(args string) string {
	var fields struct {
		Path  string `json:"path"`
		Query string `json:"query"`
	}
	if json.Unmarshal([]byte(args), &fields) != nil {
		return ""
	}
	if fields.Query != "" {
		return fields.Query
	}
	return fields.Path
}

// turnPayload stores the turn's cards, search results and reports beside the answer, so reopening the
// conversation redraws a pending approval rather than losing it.
func turnPayload(cards []assistant.Card, hits, reports []json.RawMessage) string {
	if len(cards) == 0 && len(hits) == 0 && len(reports) == 0 {
		return "{}"
	}
	out := map[string]any{}
	if len(cards) > 0 {
		out["cards"] = cards
	}
	// One array of rows, not an array of searches: two searches in one turn are
	// still one set of results to the reader.
	if flat := flattenHits(hits); len(flat) > 0 {
		out["hits"] = flat
	}
	if len(reports) > 0 {
		out["reports"] = reports
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// cardEvent is a card as the stream carries it.
func cardEvent(card assistant.Card) map[string]any {
	out := map[string]any{"type": "card", "kind": card.Kind}
	switch card.Kind {
	case assistant.CardPlan:
		out["plan_id"] = card.PlanID
		out["plan_kind"] = card.PlanKind
		out["summary"] = card.Summary
		out["items"] = card.Items
		out["status"] = model.PlanPending
	default:
		out["path"] = card.Path
		out["reason"] = card.Reason
		if card.Decision != "" {
			out["decision"] = card.Decision
		}
	}
	return out
}

// approvalWait bounds how long a turn stands still for an answer to a read
// request. The stream stays open and the account's one turn slot stays taken
// while it waits, so a person who walked away has to let the model go on
// without the file eventually — and can ask again when they are back.
const approvalWait = 5 * time.Minute

type approvalKey struct {
	session int64
	path    string
}

// approvalDesk is where a turn waiting on a permission and the click that
// answers it meet. A waiting turn registers the file it asked about; the
// approvals endpoint, on another connection, hands the decision over. One
// waiter per file per conversation — the tool asks for one file at a time.
type approvalDesk struct {
	mu      sync.Mutex
	waiting map[approvalKey]chan string
}

func (d *approvalDesk) expect(session int64, path string) <-chan string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.waiting == nil {
		d.waiting = map[approvalKey]chan string{}
	}
	ch := make(chan string, 1)
	d.waiting[approvalKey{session, path}] = ch
	return ch
}

func (d *approvalDesk) forget(session int64, path string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.waiting, approvalKey{session, path})
}

// decide hands the answer to the turn waiting for it, if one is.
func (d *approvalDesk) decide(session int64, path, decision string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if ch, ok := d.waiting[approvalKey{session, path}]; ok {
		select {
		case ch <- decision:
		default:
		}
	}
}

// Approve records the person's answer to a request to read ONE file inside
// this conversation, and hands it to the turn waiting for it.
//
//	POST /api/assistant/sessions/{id}/approvals   {"path": "main://Docs/pay.csv", "decision": "allow"|"deny"}
//
// `decision` defaults to allow. Allowing stores a grant, so the file needs no
// second permission later in the conversation; denying stores nothing — the
// model is told, in the tool's result, to go on without the file.
//
// ⚠ It takes one path and answers for one path. There is no "approve
// everything" form here and no folder form, because the rule this endpoint
// exists to enforce is that permission is given per file — a body that could
// express "all of them" would make the card in front of the person decorative.
func (h *Assistant) Approve(w http.ResponseWriter, r *http.Request) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	var req struct {
		Path     string `json:"path"`
		Decision string `json:"decision"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPromptBytes)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	decision := assistant.DecisionAllowed
	switch req.Decision {
	case "", "allow":
	case "deny":
		decision = assistant.DecisionDenied
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "decision must be allow or deny"})
		return
	}
	if decision == assistant.DecisionAllowed {
		if err := h.Store.GrantAssistantRead(r.Context(), session.ID, path); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	h.desk.decide(session.ID, path, decision)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": path, "decision": decision})
}

// flattenHits concatenates the per-search arrays into one. A search whose
// payload cannot be read is skipped: it was already sent to the client, and a
// stored answer is worth more than an exact copy of it.
func flattenHits(searches []json.RawMessage) []json.RawMessage {
	var out []json.RawMessage
	for _, raw := range searches {
		var rows []json.RawMessage
		if json.Unmarshal(raw, &rows) != nil {
			continue
		}
		out = append(out, rows...)
	}
	return out
}
