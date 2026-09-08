// Package handlers — assistant.go
//
// The assistant's conversation history.
//
//	GET    /api/assistant/sessions          (auth)  the caller's conversations
//	POST   /api/assistant/sessions          (auth)  start one
//	GET    /api/assistant/sessions/{id}     (auth)  its messages — OWNER ONLY
//	PATCH  /api/assistant/sessions/{id}     (auth)  rename it
//	DELETE /api/assistant/sessions/{id}     (auth)  drop it
//
// Ownership is checked against the context principal on every route, and the
// message route has NO administrator path through it. That is the privacy rule
// the two-table schema exists for: an administrator may see that an account
// holds forty conversations and may delete one, and may never read a line of
// any of them. An "admin can read it for support" branch would make the split
// pointless, so there is none to disable.
package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
)

// Assistant handles the session surface. The turn itself (the model, the tools,
// the approvals) is a separate handler — this one is only the history.
type Assistant struct {
	Store db.Store
	// AI is the model side (assistant_turn.go). Nil on an installation with no
	// provider configured, which is the default and answers 503.
	AI *assistant.Service
	// Tools is the file surface the assistant may look at (assistant_tools.go).
	// Nil leaves the model with no tools at all.
	Tools *AssistantToolDeps
}

// NewAssistant constructs the handler.
func NewAssistant(store db.Store) *Assistant { return &Assistant{Store: store} }

// chatSessionView is what a conversation looks like on the wire. No message text, by
// construction: the store method that would carry it is not called here.
type chatSessionView struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	TitleManual  bool   `json:"title_manual"`
	MessageCount int    `json:"message_count"`
	LastActiveAt string `json:"last_active_at"`
	CreatedAt    string `json:"created_at"`
}

func toChatSessionView(s *model.AssistantSession) chatSessionView {
	return chatSessionView{
		ID:           strconv.FormatInt(s.ID, 10),
		Title:        s.Title,
		TitleManual:  s.TitleManual,
		MessageCount: s.MessageCount,
		LastActiveAt: s.LastActiveAt.UTC().Format(time.RFC3339),
		CreatedAt:    s.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// Sessions lists the caller's conversations, most recently active first — the
// order the list is drawn in and the order eviction reads from the far end.
func (h *Assistant) Sessions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	rows, err := h.Store.ListAssistantSessions(r.Context(), u.ID, model.MaxAssistantSessions)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]chatSessionView, 0, len(rows))
	for _, s := range rows {
		out = append(out, toChatSessionView(s))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out, "max": model.MaxAssistantSessions})
}

type createSessionReq struct {
	Title string `json:"title"`
}

// CreateSession starts a conversation and evicts what no longer fits.
//
// Eviction runs on creation rather than on a timer: the cap is about how much
// history one account keeps, and the only moment that number grows is here.
func (h *Assistant) CreateSession(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	var req createSessionReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}
	session, err := h.Store.CreateAssistantSession(r.Context(), &model.AssistantSession{
		UserID:      u.ID,
		Title:       clampTitle(req.Title),
		TitleManual: strings.TrimSpace(req.Title) != "",
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	evicted, err := h.Store.EvictAssistantSessions(r.Context(), u.ID, model.MaxAssistantSessions)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": toChatSessionView(session), "evicted": evicted})
}

// Messages returns one conversation. Owner only — see the package comment.
func (h *Assistant) Messages(w http.ResponseWriter, r *http.Request) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	rows, err := h.Store.ListAssistantMessages(r.Context(), session.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// A plan card is redrawn from the PLAN, not from the message it was stored
	// in: a plan that has since been run must not still show an Approve button.
	plans := h.planViews(r.Context(), session.ID)
	out := make([]map[string]any, 0, len(rows))
	for _, m := range rows {
		row := map[string]any{
			"id":            strconv.FormatInt(m.ID, 10),
			"role":          m.Role,
			"content":       m.Content,
			"aborted":       m.Aborted,
			"secret_notice": m.SecretNotice,
			"created_at":    m.CreatedAt.UTC().Format(time.RFC3339),
		}
		if cards := storedCards(m.PayloadJSON); len(cards) > 0 {
			row["cards"] = hydratePlans(cards, plans)
		}
		if hits := storedHits(m.PayloadJSON); len(hits) > 0 {
			row["hits"] = hits
		}
		out = append(out, row)
	}
	// The approvals given in this conversation travel with it, so a reopened
	// chat draws a card the person already answered as answered rather than
	// asking them for the same file twice.
	grants, err := h.Store.ListAssistantReadGrants(r.Context(), session.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session":  toChatSessionView(session),
		"messages": out,
		"granted":  grants,
	})
}

type renameSessionReq struct {
	Title string `json:"title"`
}

// RenameSession records a title the person chose, which the title generator
// then leaves alone for the life of the conversation.
func (h *Assistant) RenameSession(w http.ResponseWriter, r *http.Request) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	var req renameSessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	title := clampTitle(req.Title)
	if title == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty title"})
		return
	}
	if err := h.Store.SetAssistantSessionTitle(r.Context(), session.ID, title, true); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	session.Title, session.TitleManual = title, true
	writeJSON(w, http.StatusOK, map[string]any{"session": toChatSessionView(session)})
}

// DeleteSession drops a conversation and its messages. Hard, with no recovery:
// this is a chat log, and keeping a copy of something the person deleted would
// contradict the whole point of the split schema.
func (h *Assistant) DeleteSession(w http.ResponseWriter, r *http.Request) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteAssistantSession(r.Context(), session.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// own resolves {id} and refuses anything that is not the caller's own session.
// A session belonging to somebody else answers 404, not 403: whether an id
// exists is itself something about another account.
func (h *Assistant) own(w http.ResponseWriter, r *http.Request) (*model.AssistantSession, bool) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return nil, false
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return nil, false
	}
	session, err := h.Store.GetAssistantSession(r.Context(), id)
	if err != nil || session == nil || session.UserID != u.ID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return nil, false
	}
	return session, true
}

// clampTitle trims and cuts to the rune budget. Runes, not bytes: the title is
// written in the user's language, and counting bytes would give Cyrillic and
// Turkish half the room Latin gets.
func clampTitle(raw string) string {
	title := strings.TrimSpace(strings.ReplaceAll(raw, "\n", " "))
	if utf8.RuneCountInString(title) <= model.AssistantTitleMaxRunes {
		return title
	}
	return string([]rune(title)[:model.AssistantTitleMaxRunes])
}

// storedCards reads the cards a turn left behind. A payload this cannot parse
// is treated as no cards: the conversation is the valuable part, and one
// unreadable row must not take the whole history down with it.
func storedCards(payload string) []assistant.Card {
	if payload == "" || payload == "{}" {
		return nil
	}
	var stored struct {
		Cards []assistant.Card `json:"cards"`
	}
	if json.Unmarshal([]byte(payload), &stored) != nil {
		return nil
	}
	return stored.Cards
}

// storedHits reads back the search results shown with an answer. They are
// returned as they were stored — the shape belongs to the panel that draws
// them, and this handler has no reason to understand a file row.
func storedHits(payload string) []json.RawMessage {
	if payload == "" || payload == "{}" {
		return nil
	}
	var stored struct {
		Hits []json.RawMessage `json:"hits"`
	}
	if json.Unmarshal([]byte(payload), &stored) != nil {
		return nil
	}
	return stored.Hits
}

// hydratePlans replaces each stored plan card with the plan's current state.
// A card whose plan is gone (the row was removed) is dropped rather than shown
// as a button that would 404.
func hydratePlans(cards []assistant.Card, plans map[string]map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(cards))
	for _, card := range cards {
		if card.Kind != assistant.CardPlan {
			out = append(out, map[string]any{"kind": card.Kind, "path": card.Path, "reason": card.Reason})
			continue
		}
		view, ok := plans[card.PlanID]
		if !ok {
			continue
		}
		row := map[string]any{"kind": card.Kind, "plan_id": card.PlanID}
		for key, value := range view {
			row[key] = value
		}
		out = append(out, row)
	}
	return out
}
