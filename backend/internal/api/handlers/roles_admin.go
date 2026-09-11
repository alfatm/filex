// Package handlers — roles_admin.go
//
// The per-role operation permissions screen (internal/perm, migration 00044).
//
//	GET /api/admin/roles          — every role + the operation catalogue
//	PUT /api/admin/roles/{name}   — replace one role's operation list
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/perm"
)

// RolesAdmin serves the role-permissions admin surface.
type RolesAdmin struct {
	Perm *perm.Service
}

// NewRolesAdmin constructs the handler.
func NewRolesAdmin(p *perm.Service) *RolesAdmin { return &RolesAdmin{Perm: p} }

// roleRow is one row of the permissions screen.
type roleRow struct {
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
	// Editable is false for admin only. Sent rather than left for the client
	// to infer: an admin looking at a greyed-out row should be able to see WHY
	// from the payload, and the PUT refuses the same case server-side.
	Editable bool `json:"editable"`
}

// editableRoles is the order the screen draws, most-privileged first.
var editableRoles = []string{model.RoleAdmin, model.RoleUser, model.RoleViewer}

// List answers GET /api/admin/roles.
//
// Permissions are the EXPANDED set — admin comes back as the whole catalogue
// rather than as `["*"]`, so the screen can render one checkbox grid for every
// row instead of a special case for the wildcard.
func (h *RolesAdmin) List(w http.ResponseWriter, r *http.Request) {
	if h.Perm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "permissions service offline"})
		return
	}
	rows := make([]roleRow, 0, len(editableRoles))
	for _, name := range editableRoles {
		ops, err := h.Perm.Permissions(r.Context(), name)
		if errors.Is(err, perm.ErrUnknownRole) {
			// A role the seed never wrote (an install that skipped 00012, say).
			// Skip it rather than 500 the whole screen.
			continue
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if ops == nil {
			ops = []string{}
		}
		rows = append(rows, roleRow{Name: name, Permissions: ops, Editable: name != model.RoleAdmin})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roles":     rows,
		"catalogue": perm.Catalogue,
	})
}

// rolePermissionsBody is the PUT payload.
type rolePermissionsBody struct {
	Permissions []string `json:"permissions"`
}

// Update answers PUT /api/admin/roles/{name}.
//
// Every rejection is a 400 with a message that names the offending value: the
// caller is an administrator on a settings screen, and "bad request" would tell
// them nothing about which checkbox their client sent wrong.
func (h *RolesAdmin) Update(w http.ResponseWriter, r *http.Request) {
	if h.Perm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "permissions service offline"})
		return
	}
	name := chi.URLParam(r, "name")
	var body rolePermissionsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	err := h.Perm.Set(r.Context(), name, body.Permissions)
	switch {
	case err == nil:
	case errors.Is(err, perm.ErrNotEditable):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "the admin role is not editable"})
		return
	case errors.Is(err, perm.ErrUnknownRole):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown role: " + name})
		return
	case errors.Is(err, perm.ErrUnknownOp):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	ops, err := h.Perm.Permissions(r.Context(), name)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ops == nil {
		ops = []string{}
	}
	writeJSON(w, http.StatusOK, roleRow{Name: name, Permissions: ops, Editable: true})
}
