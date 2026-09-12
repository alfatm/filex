// Package handlers — groups_admin.go
//
// Admin CRUD for user groups (migration 00043).
//
//	GET    /api/admin/groups?q=&limit=&offset=
//	POST   /api/admin/groups                       {name, description?}
//	GET    /api/admin/groups/{id}                  → group + members
//	PATCH  /api/admin/groups/{id}                  {name?, description?}
//	DELETE /api/admin/groups/{id}
//	PUT    /api/admin/groups/{id}/members          {user_ids:[…]}   (replace)
//	POST   /api/admin/groups/{id}/members          {user_id}
//	DELETE /api/admin/groups/{id}/members/{userId}
//
// Tenancy works exactly as it does for users: a group is homed in the caller's
// provider, a tenant admin never lists or reaches another tenant's groups, and
// an out-of-tenant id answers 404 rather than 403 so it is not an existence
// oracle.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
)

// GroupsAdmin serves /api/admin/groups.
type GroupsAdmin struct {
	Store db.Store
}

// NewGroupsAdmin constructs the handler.
func NewGroupsAdmin(store db.Store) *GroupsAdmin { return &GroupsAdmin{Store: store} }

// groupRow is the listing shape: what an admin table draws, nothing more.
func groupRow(g *model.Group) map[string]any {
	return map[string]any{
		"id":           g.ID,
		"name":         g.Name,
		"description":  g.Description,
		"member_count": g.MemberCount,
		"created_at":   g.CreatedAt,
	}
}

// List returns a page of groups.
func (h *GroupsAdmin) List(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r.URL.Query().Get("limit"), 50, 500)
	offset := parseLimit(r.URL.Query().Get("offset"), 0, 1_000_000)
	groups, total, err := h.Store.ListGroups(r.Context(), r.URL.Query().Get("q"), scopeProvider(r.Context()), limit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(groups))
	for _, g := range groups {
		out = append(out, groupRow(g))
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": out, "total": total, "limit": limit, "offset": offset})
}

type groupWriteReq struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

// nameTaken reports whether another group in the same tenant already answers to
// name. The unique index cannot decide this on its own: provider_id is NULL on
// a single-tenant install and SQL treats every NULL as distinct.
func (h *GroupsAdmin) nameTaken(ctx context.Context, name string, exceptID int64) (bool, error) {
	groups, _, err := h.Store.ListGroups(ctx, name, scopeProvider(ctx), 100, 0)
	if err != nil {
		return false, err
	}
	for _, g := range groups {
		if g.ID != exceptID && strings.EqualFold(g.Name, name) {
			return true, nil
		}
	}
	return false, nil
}

// Create makes a group in the caller's tenant.
func (h *GroupsAdmin) Create(w http.ResponseWriter, r *http.Request) {
	var req groupWriteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	name := ""
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
	}
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	taken, err := h.nameTaken(r.Context(), name, 0)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if taken {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "a group with that name already exists"})
		return
	}
	g := &model.Group{Name: name, ProviderID: scopeProvider(r.Context())}
	if req.Description != nil {
		g.Description = strings.TrimSpace(*req.Description)
	}
	if u := auth.UserFrom(r.Context()); u != nil {
		id := u.ID
		g.CreatedBy = &id
	}
	created, err := h.Store.CreateGroup(r.Context(), g)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "could not create group: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, groupRow(created))
}

// gate resolves {id} and rejects an out-of-tenant group as not-found.
func (h *GroupsAdmin) gate(w http.ResponseWriter, r *http.Request) (*model.Group, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return nil, false
	}
	g, gerr := h.Store.GetGroup(r.Context(), id)
	if gerr != nil || g == nil || !groupInScope(r.Context(), g) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "group not found"})
		return nil, false
	}
	return g, true
}

// Get returns one group with its members.
func (h *GroupsAdmin) Get(w http.ResponseWriter, r *http.Request) {
	g, ok := h.gate(w, r)
	if !ok {
		return
	}
	members, err := h.Store.ListGroupMembers(r.Context(), g.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rows := make([]map[string]any, 0, len(members))
	for _, u := range members {
		rows = append(rows, map[string]any{
			"id": u.ID, "email": u.Email, "display_name": u.DisplayName, "role": u.Role,
		})
	}
	out := groupRow(g)
	out["members"] = rows
	writeJSON(w, http.StatusOK, out)
}

// Update renames a group / edits its description.
func (h *GroupsAdmin) Update(w http.ResponseWriter, r *http.Request) {
	g, ok := h.gate(w, r)
	if !ok {
		return
	}
	var req groupWriteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	name, description := g.Name, g.Description
	if req.Name != nil {
		if name = strings.TrimSpace(*req.Name); name == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
			return
		}
	}
	if req.Description != nil {
		description = strings.TrimSpace(*req.Description)
	}
	if name != g.Name {
		taken, err := h.nameTaken(r.Context(), name, g.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if taken {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "a group with that name already exists"})
			return
		}
	}
	if err := h.Store.UpdateGroup(r.Context(), g.ID, name, description); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	updated, err := h.Store.GetGroup(r.Context(), g.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, groupRow(updated))
}

// Delete removes the group; membership and every grant addressed to it go too.
func (h *GroupsAdmin) Delete(w http.ResponseWriter, r *http.Request) {
	g, ok := h.gate(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteGroup(r.Context(), g.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type membersReplaceReq struct {
	UserIDs []int64 `json:"user_ids"`
}

type memberAddReq struct {
	UserID int64 `json:"user_id"`
}

// memberInScope reports whether the caller may put this account in a group: it
// must exist and belong to the same tenant. Cross-tenant membership is a 400,
// not a 404 — the admin named an account they can already see in their own user
// list, so the useful answer is "that one is not yours", not "no such user".
func (h *GroupsAdmin) memberInScope(ctx context.Context, userID int64) bool {
	u, err := h.Store.GetUser(ctx, userID)
	if err != nil || u == nil {
		return false
	}
	p := scopeProvider(ctx)
	if p == nil {
		return true
	}
	return u.ProviderID != nil && *u.ProviderID == *p
}

// ReplaceMembers sets the membership to exactly the given accounts.
func (h *GroupsAdmin) ReplaceMembers(w http.ResponseWriter, r *http.Request) {
	g, ok := h.gate(w, r)
	if !ok {
		return
	}
	var req membersReplaceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	// Validate every id BEFORE writing: a replace that applied the good half
	// would have silently dropped members the caller meant to keep.
	for _, uid := range req.UserIDs {
		if !h.memberInScope(r.Context(), uid) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown user_id: " + strconv.FormatInt(uid, 10)})
			return
		}
	}
	if err := h.Store.SetGroupMembers(r.Context(), g.ID, req.UserIDs); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "member_count": len(req.UserIDs)})
}

// AddMember puts one account in the group.
func (h *GroupsAdmin) AddMember(w http.ResponseWriter, r *http.Request) {
	g, ok := h.gate(w, r)
	if !ok {
		return
	}
	var req memberAddReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if !h.memberInScope(r.Context(), req.UserID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown user_id"})
		return
	}
	if err := h.Store.AddGroupMember(r.Context(), g.ID, req.UserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// RemoveMember takes one account out of the group — and with it, every access
// that account only had through the group.
func (h *GroupsAdmin) RemoveMember(w http.ResponseWriter, r *http.Request) {
	g, ok := h.gate(w, r)
	if !ok {
		return
	}
	uid, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad user id"})
		return
	}
	if err := h.Store.RemoveGroupMember(r.Context(), g.ID, uid); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
