// Package handlers — assistant_admin.go
//
//	GET    /api/admin/assistant/sessions       (admin)  who holds how much history
//	DELETE /api/admin/assistant/sessions/{id}  (admin)  drop one
//
// An operator needs to see that the assistant's history exists and to be able
// to clear it — for a departing employee, for a support case, for a machine
// running out of room. None of that requires reading a conversation, so none of
// it does: this file contains no call to ListAssistantMessages, and that is the
// enforcement. The privacy promise is not a checkbox somewhere; it is the
// absence of a query.
//
// The TITLE is shown, deliberately. It is generated under a prompt that forbids
// putting anything from the conversation into it, and without a name the list
// would be unusable for the one job it has.
package handlers

import (
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/db"
)

// AssistantAdmin is the operator's view of assistant history.
type AssistantAdmin struct {
	Store db.Store
}

// NewAssistantAdmin constructs the handler.
func NewAssistantAdmin(store db.Store) *AssistantAdmin { return &AssistantAdmin{Store: store} }

// Sessions lists every account's conversations as metadata, newest activity
// first, each named by its owner.
func (h *AssistantAdmin) Sessions(w http.ResponseWriter, r *http.Request) {
	users, err := h.Store.ListUsers(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	type row struct {
		ID           string `json:"id"`
		UserID       int64  `json:"user_id"`
		UserEmail    string `json:"user_email"`
		Title        string `json:"title"`
		MessageCount int    `json:"message_count"`
		LastActiveAt string `json:"last_active_at"`
		CreatedAt    string `json:"created_at"`
	}
	out := []row{}
	for _, u := range users {
		sessions, serr := h.Store.ListAssistantSessions(r.Context(), u.ID, 0)
		if serr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": serr.Error()})
			return
		}
		for _, s := range sessions {
			view := toChatSessionView(s)
			out = append(out, row{
				ID: view.ID, UserID: u.ID, UserEmail: u.Email, Title: view.Title,
				MessageCount: view.MessageCount, LastActiveAt: view.LastActiveAt, CreatedAt: view.CreatedAt,
			})
		}
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].LastActiveAt > out[b].LastActiveAt })
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// DeleteSession removes one conversation, whoever owns it.
func (h *AssistantAdmin) DeleteSession(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	// Two outcomes, not one: an id that is not there is a 404, and a database
	// that will not answer is a 500. Reporting the second as the first hid every
	// degradation from monitoring and told the operator the row was already gone.
	session, err := h.Store.GetAssistantSession(r.Context(), id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err != nil || session == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err := h.Store.DeleteAssistantSession(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
