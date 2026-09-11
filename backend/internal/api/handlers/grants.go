package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/auth/drivers/local"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/mailer"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/perm"
	"github.com/brf-tech/filex/backend/internal/share"
	"github.com/brf-tech/filex/backend/internal/tenant"
	"github.com/brf-tech/filex/backend/internal/tenanturl"
)

// Grants is the per-file/per-folder permission-management API backing the
// explorer's right-side "İzinler" (Permissions) panel. It is mounted under
// /api/files/permissions inside the authenticated group (session OR token),
// so confine.Middleware still applies to any path fields.
//
// Authorization: CHANGING the list (create, update, delete, invite) needs an
// admin or owner-level (acl.LevelOwner) on the target path. READING it needs
// only viewer — "who else can see this" is a question anybody who can open the
// file may ask, and the answer carries `can_manage` so the client knows which
// of the two it is holding.
type Grants struct {
	Store     db.Store
	ACL       *acl.Resolver
	Share     *share.Service // optional — nil disables the share fallback in Invite
	Mailer    *mailer.Service
	PublicURL string
	// Tenants resolves which origin the invite e-mails link to. ⚠ The
	// account-created mail carries a temporary password next to a login URL —
	// on the operator's host that login cannot succeed, and the operator's
	// hostname leaks to every tenant that adds a user.
	Tenants tenanturl.Resolver
}

// AttachTenants wires the shared per-request origin resolver (internal/tenanturl).
func (h *Grants) AttachTenants(rv tenanturl.Resolver) { h.Tenants = rv }

// NewGrants constructs the permissions handler.
func NewGrants(store db.Store, resolver *acl.Resolver) *Grants {
	return &Grants{Store: store, ACL: resolver}
}

// AttachInvite wires the share service + mailer + public URL used by the
// email-invite flow (existing user → grant, admin → create user, else share).
func (h *Grants) AttachInvite(sh *share.Service, m *mailer.Service, publicURL string) {
	h.Share = sh
	h.Mailer = m
	h.PublicURL = strings.TrimRight(publicURL, "/")
	h.Tenants = tenanturl.New(h.Store, publicURL, h.Tenants.MultiTenant)
}

// tryMail sends best-effort; returns true iff the mail actually went out (SMTP
// configured + verified). A false result tells the caller to surface the link /
// temp password on-screen instead.
func (h *Grants) tryMail(ctx context.Context, to, subject, body string) bool {
	if h.Mailer == nil {
		return false
	}
	return h.Mailer.Send(ctx, to, subject, body) == nil
}

// grantView is the enriched grant row returned to the panel for a grant
// addressed to ONE ACCOUNT. Principal is always "user" — it is written even
// though it is constant, because the same array also carries group rows and a
// client must not have to infer which is which from the presence of a field.
type grantView struct {
	*model.FileGrant
	Principal       string `json:"principal"`
	UserEmail       string `json:"user_email"`
	UserDisplayName string `json:"user_display_name"`
	Inherited       bool   `json:"inherited"`
}

// groupGrantView is the same row for a grant addressed to a GROUP. It carries
// no user_* fields: there is no single account behind it, and filling them with
// the empty string would read as "an account with no e-mail".
type groupGrantView struct {
	*model.FileGroupGrant
	Principal   string `json:"principal"`
	GroupName   string `json:"group_name"`
	MemberCount int    `json:"member_count"`
	Inherited   bool   `json:"inherited"`
}

// scopeProvider is the provider id a group listing must be confined to, or nil
// for "every tenant" (single-tenant installs, supertenant callers).
func scopeProvider(ctx context.Context) *int64 {
	scope, ok := tenant.FromContext(ctx)
	if !ok || scope.IsSupertenant {
		return nil
	}
	id := scope.ProviderID
	return &id
}

// groupInScope reports whether g belongs to the caller's tenant. A group from
// another tenant must read as "does not exist", the same no-exists-oracle rule
// the user gate and the grant path already follow.
func groupInScope(ctx context.Context, g *model.Group) bool {
	p := scopeProvider(ctx)
	if p == nil {
		return true
	}
	return g != nil && g.ProviderID != nil && *g.ProviderID == *p
}

// loadGroup resolves a group id for a caller, refusing out-of-tenant ids as
// not-found. The bool is false when an error has already been written.
func (h *Grants) loadGroup(w http.ResponseWriter, r *http.Request, id int64) (*model.Group, bool) {
	if id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing group_id"})
		return nil, false
	}
	g, err := h.Store.GetGroup(r.Context(), id)
	if err != nil || g == nil || !groupInScope(r.Context(), g) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "group not found"})
		return nil, false
	}
	return g, true
}

// resolvePath splits an adapter://rel path and loads the storage row. Returns
// the storage, the cleaned rel, or an error already written to w.
func (h *Grants) resolvePath(w http.ResponseWriter, r *http.Request, raw string) (*model.Storage, string, bool) {
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path"})
		return nil, "", false
	}
	adapter, rel := splitAdapterPath(raw)
	// Elsewhere in the API an unqualified path falls back to storages[0], but
	// a grant is durable authorization state and guessing its storage is not
	// recoverable by looking again. olivov posted {"path":"/deneme"} and
	// watched the grant land on a different tenant's storage; adding a
	// `storage` / `storage_id` field to the body changed nothing, because no
	// such field is read (H6, 2026-08-05). Say which storage.
	if adapter == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": `path must name a storage, e.g. "Dosyalar://klasor"`,
		})
		return nil, "", false
	}
	st, err := h.Store.GetStorageByName(r.Context(), adapter)
	// GetStorageByName is not one of the methods tenantstore confines, so the
	// tenant gate is applied here. Out-of-tenant reads as unknown — same
	// answer as a name that doesn't exist, so this isn't an existence oracle.
	if err != nil || st == nil || !scopeOf(r.Context()).CanAccessStorage(st.ID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown adapter: " + adapter})
		return nil, "", false
	}
	return st, acl.CleanRel(rel), true
}

// scopeOf returns the request's tenant scope; a nil scope means "unscoped"
// (single-tenant mode) and reaches everything, per tenant.Scope's contract.
func scopeOf(ctx context.Context) *tenant.Scope {
	s, ok := tenant.FromContext(ctx)
	if !ok {
		return nil
	}
	return s
}

// requireEditor reports whether the caller may write/share at (st, rel):
// admin, or acl.LevelEditor effective there. Used by the share-by-email action
// (same capability that created the link). Writes 403 + returns false if not.
func (h *Grants) requireEditor(w http.ResponseWriter, r *http.Request, st *model.Storage, rel string) bool {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	if u.IsAdmin() {
		return true
	}
	if h.ACL == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return false
	}
	set, err := h.ACL.LoadSet(r.Context(), u, st)
	if err != nil || set == nil || set.Effective(rel) < acl.LevelEditor {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return false
	}
	return true
}

// requireOwner reports whether the caller may manage permissions on (st, rel):
// admin, or acl.LevelOwner effective there. Writes 403 + returns false if not.
func (h *Grants) requireOwner(w http.ResponseWriter, r *http.Request, st *model.Storage, rel string) bool {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	if u.IsAdmin() {
		return true
	}
	if h.ACL == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return false
	}
	set, err := h.ACL.LoadSet(r.Context(), u, st)
	if err != nil || set == nil || set.Effective(rel) < acl.LevelOwner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an owner can manage permissions here"})
		return false
	}
	return true
}

// List returns the direct + inherited grants for a path so the panel can show
// who has access (including permissions cascading from parent folders).
//
//	GET /api/files/permissions?path=<adapter://rel>
func (h *Grants) List(w http.ResponseWriter, r *http.Request) {
	st, rel, ok := h.resolvePath(w, r, r.URL.Query().Get("path"))
	if !ok {
		return
	}
	// Reading the list is a viewer's business, not an owner's: "who else can see
	// this" is a question anybody who can see the file may ask, and answering it
	// only to owners left every non-owner staring at a panel that listed them
	// alone. Changing the list stays owner-only — that guard is on the mutating
	// verbs below, and `can_manage` tells the client which of the two it is.
	level, ok := h.readLevel(w, r, st, rel)
	if !ok {
		return
	}
	all, err := h.Store.ListFileGrantsByStorage(r.Context(), st.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	direct := []any{}
	inherited := []any{}
	for _, g := range all {
		gp := acl.CleanRel(g.PathPrefix)
		gv := grantView{FileGrant: g, Principal: model.PrincipalUser}
		if u, uerr := h.Store.GetUser(r.Context(), g.UserID); uerr == nil && u != nil {
			gv.UserEmail = u.Email
			gv.UserDisplayName = u.DisplayName
		}
		switch {
		case gp == rel:
			direct = append(direct, gv)
		case gp == "" || strings.HasPrefix(rel, gp+"/"):
			// Ancestor folder grant → inherited onto this path.
			gv.Inherited = true
			inherited = append(inherited, gv)
		}
	}
	// Group grants sit in their own table but belong in the same two arrays —
	// the panel's question is "who reaches this path", and the answer is a
	// mixture of people and teams.
	groupGrants, err := h.Store.ListFileGroupGrantsByPath(r.Context(), st.ID, rel)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	for _, gg := range groupGrants {
		gv := groupGrantView{FileGroupGrant: gg, Principal: model.PrincipalGroup}
		if grp, gerr := h.Store.GetGroup(r.Context(), gg.GroupID); gerr == nil && grp != nil {
			gv.GroupName = grp.Name
			gv.MemberCount = grp.MemberCount
		}
		if acl.CleanRel(gg.PathPrefix) == rel {
			direct = append(direct, gv)
			continue
		}
		gv.Inherited = true
		inherited = append(inherited, gv)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":         st.Name + "://" + rel,
		"storage_rbac": st.RBACEnabled,
		"direct":       direct,
		"inherited":    inherited,
		"effective":    level.String(),
		"can_manage":   level >= acl.LevelOwner,
	})
}

// readLevel authorises a READ of the permission list and hands back the level it
// authorised with, so the answer can say whether the same caller may also change
// it. Anything below viewer is refused: the list names people, and naming them
// to somebody who cannot open the file would be a leak of its own.
func (h *Grants) readLevel(w http.ResponseWriter, r *http.Request, st *model.Storage, rel string) (acl.Level, bool) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return acl.LevelNone, false
	}
	if u.IsAdmin() {
		return acl.LevelOwner, true
	}
	if h.ACL == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return acl.LevelNone, false
	}
	set, err := h.ACL.LoadSet(r.Context(), u, st)
	if err != nil || set == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return acl.LevelNone, false
	}
	level := set.Effective(rel)
	if level < acl.LevelViewer {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "no access to this path"})
		return acl.LevelNone, false
	}
	return level, true
}

type grantCreateReq struct {
	Path   string `json:"path"`
	UserID int64  `json:"user_id"`
	// GroupID addresses the grant to a group instead of an account. Exactly one
	// of user_id / group_id is expected; group_id wins if both are sent, so a
	// client that leaves a stale user_id in its form cannot silently grant twice.
	GroupID int64  `json:"group_id,omitempty"`
	Level   string `json:"level"`
	IsDir   *bool  `json:"is_dir,omitempty"`
}

// Create (upsert) a grant for a user or a group on a path.
//
//	POST /api/files/permissions {path, user_id|group_id, level, is_dir?}
func (h *Grants) Create(w http.ResponseWriter, r *http.Request) {
	// files.grant — handing another account access. Separate from files.share
	// because the two have different blast radii: a link reaches whoever holds
	// the URL, a grant permanently widens who may act on the item from inside.
	if !requirePerm(w, r, perm.OpGrant) {
		return
	}
	var req grantCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	st, rel, ok := h.resolvePath(w, r, req.Path)
	if !ok {
		return
	}
	if !st.RBACEnabled {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "enable RBAC on this storage before granting per-item access"})
		return
	}
	if !h.requireOwner(w, r, st, rel) {
		return
	}
	if !model.ValidGrantLevel(req.Level) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid level"})
		return
	}
	isDir := true
	if req.IsDir != nil {
		isDir = *req.IsDir
	}
	var createdBy *int64
	if u := auth.UserFrom(r.Context()); u != nil {
		id := u.ID
		createdBy = &id
	}
	if req.GroupID > 0 {
		if _, ok := h.loadGroup(w, r, req.GroupID); !ok {
			return
		}
		gg, gerr := h.Store.CreateFileGroupGrant(r.Context(), &model.FileGroupGrant{
			StorageID:  st.ID,
			PathPrefix: rel,
			IsDir:      isDir,
			GroupID:    req.GroupID,
			Level:      req.Level,
			CreatedBy:  createdBy,
		})
		if gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": gerr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, gg)
		return
	}
	if req.UserID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing user_id"})
		return
	}
	target, err := h.Store.GetUser(r.Context(), req.UserID)
	if err != nil || target == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}
	// Account-role ceiling: a viewer account may only ever hold viewer grants.
	if target.IsViewer() && req.Level != model.GrantViewer {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a viewer account can only be granted viewer access"})
		return
	}
	g, err := h.Store.CreateFileGrant(r.Context(), &model.FileGrant{
		StorageID:  st.ID,
		PathPrefix: rel,
		IsDir:      isDir,
		UserID:     req.UserID,
		Level:      req.Level,
		CreatedBy:  createdBy,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, g)
}

type grantPatchReq struct {
	Level string `json:"level"`
}

// isGroupPrincipal reports whether the request addresses a group grant. The two
// tables have independent id spaces, so the id alone cannot say which row is
// meant — `?principal=group` disambiguates and its absence keeps every existing
// caller pointing at file_grants.
func isGroupPrincipal(r *http.Request) bool {
	return r.URL.Query().Get("principal") == model.PrincipalGroup
}

// Update changes a grant's level.
//
//	PATCH /api/files/permissions/{id}[?principal=group] {level}
func (h *Grants) Update(w http.ResponseWriter, r *http.Request) {
	if !requirePerm(w, r, perm.OpGrant) {
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if isGroupPrincipal(r) {
		h.updateGroupGrant(w, r, id)
		return
	}
	g, err := h.Store.GetFileGrant(r.Context(), id)
	if err != nil || g == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
		return
	}
	var req grantPatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if !model.ValidGrantLevel(req.Level) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid level"})
		return
	}
	st, ok := h.authorizeGrant(w, r, g)
	if !ok {
		return
	}
	_ = st
	if target, uerr := h.Store.GetUser(r.Context(), g.UserID); uerr == nil && target != nil {
		if target.IsViewer() && req.Level != model.GrantViewer {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a viewer account can only be granted viewer access"})
			return
		}
	}
	if err := h.Store.UpdateFileGrantLevel(r.Context(), id, req.Level); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// updateGroupGrant is Update for a `?principal=group` row: the same owner
// requirement on the grant's own path, minus the viewer-account ceiling (a
// group has no role; the ceiling still applies per member at resolve time).
func (h *Grants) updateGroupGrant(w http.ResponseWriter, r *http.Request, id int64) {
	gg, err := h.Store.GetFileGroupGrant(r.Context(), id)
	if err != nil || gg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
		return
	}
	var req grantPatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if !model.ValidGrantLevel(req.Level) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid level"})
		return
	}
	if !h.authorizeGroupGrant(w, r, gg) {
		return
	}
	if err := h.Store.UpdateFileGroupGrantLevel(r.Context(), id, req.Level); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// authorizeGroupGrant is authorizeGrant for a group row.
func (h *Grants) authorizeGroupGrant(w http.ResponseWriter, r *http.Request, gg *model.FileGroupGrant) bool {
	st, err := h.Store.GetStorage(r.Context(), gg.StorageID)
	if err != nil || st == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "storage not found"})
		return false
	}
	return h.requireOwner(w, r, st, acl.CleanRel(gg.PathPrefix))
}

// Delete revokes a grant.
//
//	DELETE /api/files/permissions/{id}[?principal=group]
func (h *Grants) Delete(w http.ResponseWriter, r *http.Request) {
	if !requirePerm(w, r, perm.OpGrant) {
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if isGroupPrincipal(r) {
		gg, gerr := h.Store.GetFileGroupGrant(r.Context(), id)
		if gerr != nil || gg == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
			return
		}
		if !h.authorizeGroupGrant(w, r, gg) {
			return
		}
		if derr := h.Store.DeleteFileGroupGrant(r.Context(), id); derr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": derr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	g, err := h.Store.GetFileGrant(r.Context(), id)
	if err != nil || g == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
		return
	}
	if _, ok := h.authorizeGrant(w, r, g); !ok {
		return
	}
	if err := h.Store.DeleteFileGrant(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// authorizeGrant loads the grant's storage and verifies the caller may manage
// it (owner of the grant's path, or admin).
func (h *Grants) authorizeGrant(w http.ResponseWriter, r *http.Request, g *model.FileGrant) (*model.Storage, bool) {
	st, err := h.Store.GetStorage(r.Context(), g.StorageID)
	if err != nil || st == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "storage not found"})
		return nil, false
	}
	if !h.requireOwner(w, r, st, acl.CleanRel(g.PathPrefix)) {
		return nil, false
	}
	return st, true
}

// AdminList returns every grant across all storages, enriched with storage
// name + user email, for the admin panel's global "İzinler" overview (who has
// what, where). Admin-only via the /api/admin route group.
//
//	GET /api/admin/grants → {grants:[{id, storage_name, path_prefix, user_email, level, …}]}
func (h *Grants) AdminList(w http.ResponseWriter, r *http.Request) {
	all, err := h.Store.ListAllFileGrants(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Multi-tenant: a tenant-admin only sees grants on its own storages
	// (docs/MULTI-TENANCY.md §9).
	scope, scoped := tenant.FromContext(r.Context())
	storageName := map[int64]string{}
	userEmail := map[int64]string{}
	out := make([]map[string]any, 0, len(all))
	for _, g := range all {
		if scoped && !scope.IsSupertenant && !scope.CanAccessStorage(g.StorageID) {
			continue
		}
		if _, ok := storageName[g.StorageID]; !ok {
			if st, e := h.Store.GetStorage(r.Context(), g.StorageID); e == nil && st != nil {
				storageName[g.StorageID] = st.Name
			}
		}
		if _, ok := userEmail[g.UserID]; !ok {
			if u, e := h.Store.GetUser(r.Context(), g.UserID); e == nil && u != nil {
				userEmail[g.UserID] = u.Email
			}
		}
		out = append(out, map[string]any{
			"id":           g.ID,
			"principal":    model.PrincipalUser,
			"storage_id":   g.StorageID,
			"storage_name": storageName[g.StorageID],
			"path":         storageName[g.StorageID] + "://" + g.PathPrefix,
			"path_prefix":  g.PathPrefix,
			"is_dir":       g.IsDir,
			"user_id":      g.UserID,
			"user_email":   userEmail[g.UserID],
			"level":        g.Level,
			"created_at":   g.CreatedAt,
		})
	}
	// Group grants live in their own table; the overview's question ("who has
	// what, where") does not care which table the row came from, so they are
	// listed alongside and tagged by `principal`.
	groupGrants, err := h.Store.ListAllFileGroupGrants(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	groupName := map[int64]string{}
	for _, gg := range groupGrants {
		if scoped && !scope.IsSupertenant && !scope.CanAccessStorage(gg.StorageID) {
			continue
		}
		if _, ok := storageName[gg.StorageID]; !ok {
			if st, e := h.Store.GetStorage(r.Context(), gg.StorageID); e == nil && st != nil {
				storageName[gg.StorageID] = st.Name
			}
		}
		if _, ok := groupName[gg.GroupID]; !ok {
			if grp, e := h.Store.GetGroup(r.Context(), gg.GroupID); e == nil && grp != nil {
				groupName[gg.GroupID] = grp.Name
			}
		}
		out = append(out, map[string]any{
			"id":           gg.ID,
			"principal":    model.PrincipalGroup,
			"storage_id":   gg.StorageID,
			"storage_name": storageName[gg.StorageID],
			"path":         storageName[gg.StorageID] + "://" + gg.PathPrefix,
			"path_prefix":  gg.PathPrefix,
			"is_dir":       gg.IsDir,
			"group_id":     gg.GroupID,
			"group_name":   groupName[gg.GroupID],
			"level":        gg.Level,
			"created_at":   gg.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"grants": out})
}

type adminGrantCreateReq struct {
	StorageID int64  `json:"storage_id"`
	Path      string `json:"path"` // storage-relative; "" == the storage root
	IsDir     *bool  `json:"is_dir,omitempty"`
	Level     string `json:"level"`
	UserID    int64  `json:"user_id,omitempty"`
	GroupID   int64  `json:"group_id,omitempty"`
}

// AdminCreate grants access from the admin panel, without standing on the path
// the way /api/files/permissions does. It addresses a storage by id and a path
// by its storage-relative form, because the admin overview lists rows that way
// and an admin fixing an access problem is rarely browsing the folder.
//
//	POST /api/admin/grants {storage_id, path, is_dir?, level, user_id|group_id}
func (h *Grants) AdminCreate(w http.ResponseWriter, r *http.Request) {
	var req adminGrantCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	st, err := h.Store.GetStorage(r.Context(), req.StorageID)
	if err != nil || st == nil || !scopeOf(r.Context()).CanAccessStorage(st.ID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "storage not found"})
		return
	}
	if !st.RBACEnabled {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "enable RBAC on this storage first"})
		return
	}
	if !model.ValidGrantLevel(req.Level) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid level"})
		return
	}
	rel := acl.CleanRel(req.Path)
	isDir := true
	if req.IsDir != nil {
		isDir = *req.IsDir
	}
	var createdBy *int64
	if u := auth.UserFrom(r.Context()); u != nil {
		id := u.ID
		createdBy = &id
	}
	if req.GroupID > 0 {
		if _, ok := h.loadGroup(w, r, req.GroupID); !ok {
			return
		}
		// The store upserts; the admin panel's POST is a create and says so, so
		// an existing row is reported rather than silently relevelled (that is
		// what PATCH is for).
		existing, lerr := h.Store.ListFileGroupGrantsByPath(r.Context(), st.ID, rel)
		if lerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": lerr.Error()})
			return
		}
		for _, e := range existing {
			if acl.CleanRel(e.PathPrefix) == rel && e.GroupID == req.GroupID {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "this group already has a grant on that path"})
				return
			}
		}
		gg, gerr := h.Store.CreateFileGroupGrant(r.Context(), &model.FileGroupGrant{
			StorageID: st.ID, PathPrefix: rel, IsDir: isDir, GroupID: req.GroupID, Level: req.Level, CreatedBy: createdBy,
		})
		if gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": gerr.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, gg)
		return
	}
	if req.UserID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing user_id"})
		return
	}
	target, terr := h.Store.GetUser(r.Context(), req.UserID)
	if terr != nil || target == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}
	if target.IsViewer() && req.Level != model.GrantViewer {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a viewer account can only be granted viewer access"})
		return
	}
	existing, lerr := h.Store.ListFileGrantsByStorageUser(r.Context(), st.ID, req.UserID)
	if lerr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": lerr.Error()})
		return
	}
	for _, e := range existing {
		if acl.CleanRel(e.PathPrefix) == rel {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "this user already has a grant on that path"})
			return
		}
	}
	g, cerr := h.Store.CreateFileGrant(r.Context(), &model.FileGrant{
		StorageID: st.ID, PathPrefix: rel, IsDir: isDir, UserID: req.UserID, Level: req.Level, CreatedBy: createdBy,
	})
	if cerr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": cerr.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

// adminGrantInScope gates an admin grant action on the grant's own storage.
//
// AdminList filters by scope and AdminCreate checks the target storage, but
// PATCH/DELETE addressed a grant by bare id: grant ids are dense integers, so
// a tenant admin could enumerate them and re-level or revoke grants on another
// tenant's storages. Out-of-tenant (and unknown-storage) answers 404, not 403,
// so the id is not an existence oracle — the same rule loadGroup and the user
// gate follow.
func (h *Grants) adminGrantInScope(w http.ResponseWriter, r *http.Request, storageID int64) bool {
	st, err := h.Store.GetStorage(r.Context(), storageID)
	if err != nil || st == nil || !scopeOf(r.Context()).CanAccessStorage(st.ID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
		return false
	}
	return true
}

// AdminUpdate changes any grant's level (admin override).
//
//	PATCH /api/admin/grants/{id}[?principal=group] {level}
func (h *Grants) AdminUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	var req grantPatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if !model.ValidGrantLevel(req.Level) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid level"})
		return
	}
	if isGroupPrincipal(r) {
		gg, gerr := h.Store.GetFileGroupGrant(r.Context(), id)
		if gerr != nil || gg == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
			return
		}
		if !h.adminGrantInScope(w, r, gg.StorageID) {
			return
		}
		if uerr := h.Store.UpdateFileGroupGrantLevel(r.Context(), id, req.Level); uerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": uerr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	g, gerr := h.Store.GetFileGrant(r.Context(), id)
	if gerr != nil || g == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
		return
	}
	if !h.adminGrantInScope(w, r, g.StorageID) {
		return
	}
	if target, uerr := h.Store.GetUser(r.Context(), g.UserID); uerr == nil && target != nil {
		if target.IsViewer() && req.Level != model.GrantViewer {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a viewer account can only be granted viewer access"})
			return
		}
	}
	if uerr := h.Store.UpdateFileGrantLevel(r.Context(), id, req.Level); uerr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": uerr.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AdminDelete revokes any grant (admin override).
//
//	DELETE /api/admin/grants/{id}[?principal=group]
func (h *Grants) AdminDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if isGroupPrincipal(r) {
		gg, gerr := h.Store.GetFileGroupGrant(r.Context(), id)
		if gerr != nil || gg == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
			return
		}
		if !h.adminGrantInScope(w, r, gg.StorageID) {
			return
		}
		if derr := h.Store.DeleteFileGroupGrant(r.Context(), id); derr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": derr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	g, gerr := h.Store.GetFileGrant(r.Context(), id)
	if gerr != nil || g == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "grant not found"})
		return
	}
	if !h.adminGrantInScope(w, r, g.StorageID) {
		return
	}
	if err := h.Store.DeleteFileGrant(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// SearchUsers returns existing accounts matching q (email or display name) so
// the permissions panel can autocomplete as the owner types. Any authenticated
// user may call it (the panel itself is owner-gated); results are capped and
// carry no secrets.
//
//	GET /api/files/permissions/users?q=<substr>
func (h *Grants) SearchUsers(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	users, err := h.Store.ListUsers(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, 10)
	for _, u := range users {
		if q != "" && !strings.Contains(strings.ToLower(u.Email), q) &&
			!strings.Contains(strings.ToLower(u.DisplayName), q) {
			continue
		}
		out = append(out, map[string]any{
			"id":           u.ID,
			"email":        u.Email,
			"display_name": u.DisplayName,
			"role":         u.Role,
		})
		if len(out) >= 10 {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

// SearchGroups returns the groups matching q so the permissions panel can offer
// them next to accounts in its "share with" picker. Any authenticated caller
// that can act on a file may ask — a viewer account cannot grant anything, so
// it is refused rather than handed the tenant's team names.
//
//	GET /api/files/permissions/groups?q=<substr>&limit=<n>
func (h *Grants) SearchGroups(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if u.IsViewer() {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"), 10, 100)
	groups, err := h.Store.SearchGroups(r.Context(), r.URL.Query().Get("q"), scopeProvider(r.Context()), limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(groups))
	for _, g := range groups {
		out = append(out, map[string]any{"id": g.ID, "name": g.Name, "member_count": g.MemberCount})
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": out})
}

// Resolve looks up a user by email so the panel can decide between a direct
// grant (existing account) and the invite flow (no account).
//
//	GET /api/files/permissions/resolve?email=<addr>
func (h *Grants) Resolve(w http.ResponseWriter, r *http.Request) {
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing email"})
		return
	}
	u, err := h.Store.GetUserByEmail(r.Context(), email)
	if err != nil || u == nil {
		writeJSON(w, http.StatusOK, map[string]any{"found": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"found": true,
		"user": map[string]any{
			"id":           u.ID,
			"email":        u.Email,
			"display_name": u.DisplayName,
			"role":         u.Role,
		},
	})
}

type inviteReq struct {
	Path string `json:"path"`
	// GroupID invites a GROUP instead of an address. There is nothing to mail
	// and nothing to fall back to: a group is always an existing principal, so
	// the only outcome is a grant (mode "granted").
	GroupID    int64  `json:"group_id,omitempty"`
	Email      string `json:"email"`
	Level      string `json:"level"`
	CreateUser bool   `json:"create_user,omitempty"`
	Role       string `json:"role,omitempty"` // new-user role when CreateUser (default "user")
	IsDir      *bool  `json:"is_dir,omitempty"`
	Locale     string `json:"locale,omitempty"` // composer UI locale (mail language fallback)
}

// Invite grants access to an email address. Three outcomes (owner/admin only):
//   - existing account → a direct ACL grant (mode "granted")
//   - no account + caller is admin + create_user → new account + grant, temp
//     password mailed (or returned for on-screen display) (mode "user_created")
//   - otherwise → a public share link, mailed or returned (mode "shared")
//
// Mail is sent only when SMTP is configured AND verified; otherwise the link /
// temp password comes back in the response for the UI to show.
//
//	POST /api/files/permissions/invite {path, email, level, create_user?, role?}
func (h *Grants) Invite(w http.ResponseWriter, r *http.Request) {
	// An invite creates an account AND a grant, so it is files.grant twice over.
	if !requirePerm(w, r, perm.OpGrant) {
		return
	}
	var req inviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	st, rel, ok := h.resolvePath(w, r, req.Path)
	if !ok {
		return
	}
	if !h.requireOwner(w, r, st, rel) {
		return
	}
	if !model.ValidGrantLevel(req.Level) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid level"})
		return
	}
	caller := auth.UserFrom(r.Context())
	var createdBy *int64
	if caller != nil {
		id := caller.ID
		createdBy = &id
	}
	isDir := true
	if req.IsDir != nil {
		isDir = *req.IsDir
	}

	// ── A group → a grant, and nothing else. ──
	if req.GroupID > 0 {
		grp, ok := h.loadGroup(w, r, req.GroupID)
		if !ok {
			return
		}
		if !st.RBACEnabled {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "enable RBAC on this storage first"})
			return
		}
		if _, gerr := h.Store.CreateFileGroupGrant(r.Context(), &model.FileGroupGrant{
			StorageID: st.ID, PathPrefix: rel, IsDir: isDir, GroupID: grp.ID, Level: req.Level, CreatedBy: createdBy,
		}); gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": gerr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"mode": "granted", "group_id": grp.ID, "group_name": grp.Name, "emailed": false,
		})
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "valid email required"})
		return
	}

	// ── Existing account → direct grant. ──
	if u, err := h.Store.GetUserByEmail(r.Context(), email); err == nil && u != nil {
		if !st.RBACEnabled {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "enable RBAC on this storage first"})
			return
		}
		if u.IsViewer() && req.Level != model.GrantViewer {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a viewer account can only be granted viewer access"})
			return
		}
		if _, gerr := h.Store.CreateFileGrant(r.Context(), &model.FileGrant{
			StorageID: st.ID, PathPrefix: rel, IsDir: isDir, UserID: u.ID, Level: req.Level, CreatedBy: createdBy,
		}); gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": gerr.Error()})
			return
		}
		// Prefer the recipient's own language; fall back to the composer's.
		loc := u.Locale
		if loc == "" {
			loc = req.Locale
		}
		subject, body := itemGrantText(loc, st.Name+"://"+rel, h.Tenants.FromRequest(r)+"/admin/explore")
		emailed := h.tryMail(r.Context(), email, subject, body)
		writeJSON(w, http.StatusOK, map[string]any{"mode": "granted", "user_id": u.ID, "emailed": emailed})
		return
	}

	// ── No account + admin + create_user → make the account + grant. ──
	if req.CreateUser {
		if caller == nil || !caller.IsAdmin() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only an admin can create new users"})
			return
		}
		if !st.RBACEnabled {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "enable RBAC on this storage first"})
			return
		}
		role := strings.TrimSpace(req.Role)
		if role == "" {
			role = model.RoleUser
		}
		if !model.ValidRole(role) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid role"})
			return
		}
		if role == model.RoleViewer && req.Level != model.GrantViewer {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a viewer account can only be granted viewer access"})
			return
		}
		tempPw := randomPIN(12)
		hash, herr := local.HashPassword(tempPw)
		if herr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": herr.Error()})
			return
		}
		// Normalize the new account's locale to tr/en from the composer's UI
		// locale (empty → en default).
		loc := "en"
		if req.Locale != "" && !mailLangEN(req.Locale) {
			loc = "tr"
		}
		newU, cerr := h.Store.CreateUser(r.Context(), email, hash, role, loc, "UTC")
		if cerr != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "could not create user: " + cerr.Error()})
			return
		}
		if _, gerr := h.Store.CreateFileGrant(r.Context(), &model.FileGrant{
			StorageID: st.ID, PathPrefix: rel, IsDir: isDir, UserID: newU.ID, Level: req.Level, CreatedBy: createdBy,
		}); gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": gerr.Error()})
			return
		}
		loginURL := h.Tenants.FromRequest(r) + "/admin/"
		subject, body := accountCreatedText(loc, loginURL, email, tempPw)
		emailed := h.tryMail(r.Context(), email, subject, body)
		resp := map[string]any{"mode": "user_created", "user_id": newU.ID, "emailed": emailed}
		if !emailed {
			resp["temp_password"] = tempPw // show once so the admin can relay it
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// ── No account, no create → public share link. ──
	if h.Share == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "sharing is not enabled"})
		return
	}
	hash := pathkey.Hash(st.ID, normalizeDBPath(rel))
	node, nerr := h.Store.GetNodeByPath(r.Context(), st.ID, hash)
	if nerr != nil || node == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "item not indexed yet — open it once, then retry"})
		return
	}
	sh, serr := h.Share.Create(r.Context(), share.CreateOpts{NodeID: node.ID, CreatedBy: createdBy})
	if serr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": serr.Error()})
		return
	}
	url := h.Tenants.FromRequest(r) + "/s/" + sh.Token
	subject, body := shareMailText(req.Locale, h.siteName(r.Context()), baseName(rel), isDir, 0, url, "", 0)
	emailed := h.tryMail(r.Context(), email, subject, body)
	// Say what actually happened. This branch is reached when the address the
	// caller typed has no account and they cannot create one — they asked to
	// share with a person and got a public link instead, which is a materially
	// weaker thing, and until now the response said so nowhere a client could
	// read.
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":    "shared",
		"url":     url,
		"emailed": emailed,
		"note":    "no account with that email; a public link was created instead",
	})
}

type shareMailReq struct {
	Path        string   `json:"path"`
	Email       string   `json:"email"`            // single recipient (back-compat)
	Emails      []string `json:"emails,omitempty"` // multiple recipients
	URL         string   `json:"url"`
	Pin         string   `json:"pin,omitempty"`
	ExpiresDays int      `json:"expires_days,omitempty"`
	Locale      string   `json:"locale,omitempty"`
	IsDir       bool     `json:"is_dir,omitempty"`
	Size        int64    `json:"size,omitempty"`
	Mode        string   `json:"mode,omitempty"` // "download" (default) | "drop"
}

// parseRecipients merges the single `email` + `emails[]` inputs, splitting each
// on commas/semicolons/whitespace/newlines, lowercasing, validating (@) and
// deduping — so one textarea of addresses or a chips array both work.
func parseRecipients(single string, list []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, chunk := range append([]string{single}, list...) {
		for _, part := range strings.FieldsFunc(chunk, func(r rune) bool {
			return r == ',' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
		}) {
			e := strings.ToLower(strings.TrimSpace(part))
			if e == "" || !strings.Contains(e, "@") || seen[e] {
				continue
			}
			seen[e] = true
			out = append(out, e)
		}
	}
	return out
}

// baseName returns the last path segment (the file/folder name).
func baseName(rel string) string {
	rel = strings.Trim(rel, "/")
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		return rel[i+1:]
	}
	return rel
}

// siteName reads the operator's configured site name (used to brand emails).
func (h *Grants) siteName(ctx context.Context) string {
	v, _ := h.Store.GetSetting(ctx, "site_name")
	return strings.TrimSpace(v)
}

// ShareMail emails an already-created public share link to an address. It does
// NOT create a share — it delivers a link the caller just made (with their
// chosen expiry/PIN) in the share tab. Gated editor+ on the path, the same
// capability that created the link. Best-effort: returns {emailed:false} when
// SMTP isn't verified so the UI keeps showing the link for manual delivery.
//
//	POST /api/files/permissions/share-mail {path, email, url}
func (h *Grants) ShareMail(w http.ResponseWriter, r *http.Request) {
	// Mailing a public link is still publishing one, so it answers to
	// files.share rather than to files.grant.
	if !requirePerm(w, r, perm.OpShare) {
		return
	}
	var req shareMailReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	st, rel, ok := h.resolvePath(w, r, req.Path)
	if !ok {
		return
	}
	if !h.requireEditor(w, r, st, rel) {
		return
	}
	recipients := parseRecipients(req.Email, req.Emails)
	if len(recipients) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "valid email required"})
		return
	}
	link := strings.TrimSpace(req.URL)
	if link == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing url"})
		return
	}
	if h.Mailer == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"emailed": false, "error": "not_configured"})
		return
	}
	// Use the composer's selected UI language (req.Locale). We intentionally do
	// NOT override with the recipient's stored locale here: a link often goes to
	// people outside the system, and the sender picks the language. A drop link
	// ("mode":"drop") is an upload invite, so it uses the upload-worded body.
	var subject, body string
	if req.Mode == model.ShareKindDrop {
		// Look the drop link's configured limits back up from the token so the
		// invite spells them out (X files, Y MB per file, allowed types).
		var maxFiles, maxSizeMB int
		var allowedExt []string
		if tok := dropTokenFromURL(link); tok != "" {
			if sh, err := h.Store.GetShareByToken(r.Context(), tok); err == nil && sh != nil && sh.IsDrop() {
				ds := parseDropSettings(sh.DropSettings)
				maxFiles, maxSizeMB, allowedExt = ds.MaxFiles, ds.MaxFileSizeMB, ds.AllowedExt
			}
		}
		subject, body = dropInviteMailText(req.Locale, h.siteName(r.Context()), baseName(rel), link, req.Pin, req.ExpiresDays, maxFiles, maxSizeMB, allowedExt)
	} else {
		subject, body = shareMailText(req.Locale, h.siteName(r.Context()), baseName(rel), req.IsDir, req.Size, link, req.Pin, req.ExpiresDays)
	}
	var sent, failed []string
	reason := ""
	for _, email := range recipients {
		if err := h.Mailer.Send(r.Context(), email, subject, body); err != nil {
			// Distinguish "SMTP not set up / not verified" (show the link) from a
			// transient send failure (worth retrying) so the UI can say which.
			reason = "send_failed"
			if errors.Is(err, mailer.ErrNotConfigured) || errors.Is(err, mailer.ErrNotVerified) {
				reason = "not_configured"
			}
			failed = append(failed, email)
			continue
		}
		sent = append(sent, email)
	}
	if len(sent) == 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"emailed": false, "error": reason, "failed": failed})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"emailed": true, "sent": sent, "failed": failed})
}
