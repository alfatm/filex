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
	"time"

	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
)

// maxPromptBytes bounds one question. Generous for anything typed, small
// enough that a client cannot push a file's worth of text through the model on
// the operator's bill.
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
}

// scopeHints turn the panel's chips into a sentence the model can act on. They
// are NOT stored with the question and not replayed: the chip belongs to the
// turn it was set for, the same way it does on screen.
var scopeHints = map[string]string{
	"filename": "For this question, search by file and folder NAMES.",
	"content":  "For this question, look inside file contents where filex has indexed them, not only at names.",
	"tags":     "For this question, narrow by tags — search_files understands `tag:<name>` terms.",
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

// Turn asks the model and streams the answer back as server-sent events:
//
//	{"type":"meta","conversation_id":"7"}   once, first
//	{"type":"tool","tool":"…","target":"…"} while a tool runs
//	{"type":"text","delta":"…"}             repeatedly
//	{"type":"card","kind":"approval"|"plan",…}  something for the person to decide
//	{"type":"title","title":"…"}            once, when a conversation is named
//	{"type":"error","message":"…"}          at most once, instead of the rest
//	{"type":"done"}                         once, last
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
		// 429 for both: one turn at a time and N per minute are the same
		// answer to the client — wait and try again.
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
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
	send := func(event map[string]any) error {
		payload, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
			return err
		}
		return stream.Flush()
	}
	_ = send(map[string]any{"type": "meta", "conversation_id": strconv.FormatInt(session.ID, 10)})

	// The toolbox is built per turn: the session id is half of every permission
	// question read_file asks.
	var box assistant.Toolbox
	if h.Tools != nil {
		box = newAssistantTools(*h.Tools, session.ID)
	}
	var answer strings.Builder
	// Cards outlive the stream: a conversation reopened tomorrow has to show
	// the same pending approval, so they are stored with the answer. So do the
	// search results — an answer that pointed at four files is half missing
	// without them.
	var cards []assistant.Card
	var hits []json.RawMessage
	askErr := h.AI.Ask(r.Context(), cfg, box, withScope(history, req.Mode), func(event assistant.Event) error {
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
		case assistant.EventCard:
			if event.Card == nil {
				return nil
			}
			cards = append(cards, *event.Card)
			out := map[string]any{"type": "card", "kind": event.Card.Kind}
			switch event.Card.Kind {
			case assistant.CardPlan:
				out["plan_id"] = event.Card.PlanID
				out["plan_kind"] = event.Card.PlanKind
				out["summary"] = event.Card.Summary
				out["items"] = event.Card.Items
				out["status"] = model.PlanPending
			default:
				out["path"] = event.Card.Path
				out["reason"] = event.Card.Reason
			}
			return send(out)
		}
		return nil
	})

	// ⚠ Persisted on a context of its own. r.Context() is already cancelled in
	// exactly the case this matters most — the person pressed stop — and
	// writing through it would drop the words they had already read.
	stopped := r.Context().Err() != nil
	h.persistAnswer(r, session.ID, answer.String(), stopped, cards, hits)

	if askErr != nil && !errors.Is(askErr, assistant.ErrNotConfigured) {
		_ = send(map[string]any{"type": "error", "message": askErr.Error()})
	} else if askErr != nil {
		_ = send(map[string]any{"type": "error", "message": "no assistant is configured"})
	}
	if askErr == nil && !stopped {
		if title := h.nameSession(r, cfg, session, prompt); title != "" {
			_ = send(map[string]any{"type": "title", "title": title})
		}
	}
	_ = send(map[string]any{"type": "done"})
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
func (h *Assistant) persistAnswer(r *http.Request, sessionID int64, text string, stopped bool, cards []assistant.Card, hits []json.RawMessage) {
	if strings.TrimSpace(text) == "" && len(cards) == 0 && len(hits) == 0 {
		return
	}
	ctx := context.WithoutCancel(r.Context())
	if _, err := h.Store.AppendAssistantMessage(ctx, &model.AssistantMessage{
		SessionID:   sessionID,
		Role:        model.AssistantRoleAssistant,
		Content:     text,
		PayloadJSON: turnPayload(cards, hits),
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

// turnPayload stores the turn's cards and search results beside the answer, so reopening the
// conversation redraws a pending approval rather than losing it.
func turnPayload(cards []assistant.Card, hits []json.RawMessage) string {
	if len(cards) == 0 && len(hits) == 0 {
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
	raw, err := json.Marshal(out)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// Approve records the person's permission to read ONE file inside this
// conversation.
//
//	POST /api/assistant/sessions/{id}/approvals   {"path": "main://Docs/pay.csv"}
//
// ⚠ It takes one path and grants one path. There is no "approve everything"
// form here and no folder form, because the rule this endpoint exists to
// enforce is that permission is given per file — a body that could express
// "all of them" would make the card in front of the person decorative.
func (h *Assistant) Approve(w http.ResponseWriter, r *http.Request) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	if err := h.Store.GrantAssistantRead(r.Context(), session.ID, path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": path})
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
