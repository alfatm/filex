// Package handlers — quota.go
//
// Endpoints:
//
//	GET   /api/files/quota/me                            (auth)
//	GET   /api/admin/quotas                              (admin)
//	PATCH /api/admin/quotas                              (admin)
//	GET   /api/admin/quotas/users?limit=&offset=&q=      (admin)
//	GET   /api/admin/users/{id}/quota                    (admin)
//	POST  /api/admin/users/{id}/quota                    (admin)
//	PATCH /api/admin/users/{id}/quota                    (admin)
//	POST  /api/admin/users/{id}/quota/recompute          (admin)
//
// /api/admin/quotas edits the INSTANCE DEFAULTS (dbsetting rows); the per-user
// endpoints edit that user's tri-state OVERRIDES — -1 unlimited, 0 inherit the
// default, N a limit. Reading a user's quota gives the EFFECTIVE numbers plus
// the raw overrides, because an admin needs both to know what clearing an
// override would do.
//
// The flat forms — /api/admin/quota/{user_id} and
// /api/admin/quota/{user_id}/recompute — are the original spelling and are
// still served. Note both take a USER id: there is no per-provider quota
// (see docs/MULTI-TENANCY.md, "Not yet").
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/dbsetting"
	"github.com/brf-tech/filex/backend/internal/quota"
)

// Quota wires quota HTTP routes.
type Quota struct {
	Service *quota.Service
	// Store is the settings table (for the instance defaults) and the user
	// listing behind /api/admin/quotas/users. nil leaves those endpoints
	// answering 503 rather than panicking.
	Store db.Store
}

// NewQuota constructs the handler.
func NewQuota(svc *quota.Service, store db.Store) *Quota { return &Quota{Service: svc, Store: store} }

// quotaUserID reads the target user id from whichever route mounted the
// handler: /api/admin/quota/{user_id} or the nested, more discoverable
// /api/admin/users/{id}/quota.
func quotaUserID(r *http.Request) (int64, bool) {
	raw := chi.URLParam(r, "user_id")
	if raw == "" {
		raw = chi.URLParam(r, "id")
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

// quotaErrStatus keeps "no such user" out of the 500 bucket. Reading a quota
// for an id that isn't a user is a client mistake, not a server fault, and
// answering 500 `sql: no rows in result set` told olivov nothing about the
// real problem — they were passing provider ids to a user endpoint (H5).
func quotaErrStatus(err error) int {
	if errors.Is(err, quota.ErrUserNotFound) {
		return http.StatusNotFound
	}
	return http.StatusInternalServerError
}

// Me returns the caller's quota snapshot.
func (h *Quota) Me(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	snap, err := h.Service.Get(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, quotaErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// setQuotaReq is the per-user PATCH/POST body. Every field is a POINTER so
// "not named" is distinguishable from "set to 0" — 0 is a meaningful value
// here (inherit the default), not an absence.
type setQuotaReq struct {
	QuotaBytes       *int64 `json:"quota_bytes"`
	QuotaFiles       *int64 `json:"quota_files"`
	QuotaUploadBytes *int64 `json:"quota_upload_bytes"`
}

// defaultsBody is the shape of GET/PATCH /api/admin/quotas.
type defaultsBody struct {
	QuotaBytes        *int `json:"quota_bytes"`
	QuotaFiles        *int `json:"quota_files"`
	UploadBytes       *int `json:"upload_bytes"`
	UploadWindowHours *int `json:"upload_window_hours"`
}

// AdminGet returns the target user's current quota + usage snapshot.
// (The admin routes bind {user_id}; reading "id" here was a long-standing
// mismatch that made these endpoints always 400 — fixed alongside.)
func (h *Quota) AdminGet(w http.ResponseWriter, r *http.Request) {
	id, ok := quotaUserID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	h.writeUserQuota(w, r, id)
}

// writeUserQuota answers the effective snapshot plus the RAW tri-state
// overrides. Both, because "quota_files: 1000" does not tell an admin whether
// clearing this user's override would change it.
func (h *Quota) writeUserQuota(w http.ResponseWriter, r *http.Request, id int64) {
	snap, err := h.Service.Get(r.Context(), id)
	if err != nil {
		writeJSON(w, quotaErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	oBytes, oFiles, oUpload, err := h.Service.Overrides(r.Context(), id)
	if err != nil {
		writeJSON(w, quotaErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	body, err := snapshotMap(snap)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	body["overrides"] = map[string]int64{
		"quota_bytes":        oBytes,
		"quota_files":        oFiles,
		"quota_upload_bytes": oUpload,
	}
	writeJSON(w, http.StatusOK, body)
}

// snapshotMap re-encodes the snapshot as a map so one extra key can be added
// without a parallel struct that would drift from Snapshot's own JSON tags.
func snapshotMap(snap quota.Snapshot) (map[string]any, error) {
	raw, err := json.Marshal(snap)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AdminSet writes whichever per-user overrides the body names.
//
// ⚠ This used to refuse every negative value. -1 is now the spelling of
// "unlimited for this user, whatever the instance default says", so only
// values BELOW -1 are refused; a field the body does not name is left alone.
func (h *Quota) AdminSet(w http.ResponseWriter, r *http.Request) {
	id, ok := quotaUserID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	var req setQuotaReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	for name, v := range map[string]*int64{
		"quota_bytes":        req.QuotaBytes,
		"quota_files":        req.QuotaFiles,
		"quota_upload_bytes": req.QuotaUploadBytes,
	} {
		if v != nil && *v < -1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": name + " must be -1 (unlimited), 0 (inherit the default) or a positive limit",
			})
			return
		}
	}
	if err := h.Service.SetOverrides(r.Context(), id, req.QuotaBytes, req.QuotaFiles, req.QuotaUploadBytes); err != nil {
		writeJSON(w, quotaErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	h.writeUserQuota(w, r, id)
}

// AdminRecompute rescans nodes owned by id and rewrites usage_bytes.
func (h *Quota) AdminRecompute(w http.ResponseWriter, r *http.Request) {
	id, ok := quotaUserID(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	used, err := h.Service.Recompute(r.Context(), id)
	if err != nil {
		writeJSON(w, quotaErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	snap, _ := h.Service.Get(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"used_bytes": used,
		"used_files": snap.UsedFiles,
	})
}

// ── instance defaults ───────────────────────────────────────────────────────

// AdminDefaults returns the four instance defaults in force.
func (h *Quota) AdminDefaults(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "settings unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"defaults": h.resolveDefaults(r)})
}

// resolveDefaults reads the four settings at the point of use, so the answer is
// what the next upload will actually be measured against.
func (h *Quota) resolveDefaults(r *http.Request) map[string]int {
	ctx := r.Context()
	return map[string]int{
		"quota_bytes":         quota.DefaultBytesSetting.Resolve(ctx, h.Store),
		"quota_files":         quota.DefaultFilesSetting.Resolve(ctx, h.Store),
		"upload_bytes":        quota.DefaultUploadBytesSetting.Resolve(ctx, h.Store),
		"upload_window_hours": quota.UploadWindowSetting.Resolve(ctx, h.Store),
	}
}

// AdminSetDefaults writes whichever of the four defaults the body names.
//
// Validation is IntSpec.Validate, i.e. the same bounds the read side clamps
// to — an operator typing an impossible window is told no while they are
// looking at the form, not silently corrected on some later read.
func (h *Quota) AdminSetDefaults(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "settings unavailable"})
		return
	}
	var body defaultsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	writes := []struct {
		spec dbsetting.IntSpec
		val  *int
	}{
		{quota.DefaultBytesSetting, body.QuotaBytes},
		{quota.DefaultFilesSetting, body.QuotaFiles},
		{quota.DefaultUploadBytesSetting, body.UploadBytes},
		{quota.UploadWindowSetting, body.UploadWindowHours},
	}
	// Validate EVERY field before writing ANY of them: a PATCH that set two
	// values and then refused the third would leave the operator's form and
	// the database disagreeing about what happened.
	for _, wsp := range writes {
		if wsp.val == nil {
			continue
		}
		if err := wsp.spec.Validate(*wsp.val); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	for _, wsp := range writes {
		if wsp.val == nil {
			continue
		}
		if err := h.Store.UpsertSetting(r.Context(), wsp.spec.Key, strconv.Itoa(*wsp.val)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"defaults": h.resolveDefaults(r)})
}

// Paging bounds for /api/admin/quotas/users.
const (
	quotaUsersDefaultLimit = 50
	quotaUsersMaxLimit     = 200
)

// AdminUsers is the admin quota table: one row per account with its raw
// overrides, its effective limits and what it is using.
//
// The effective numbers are computed here rather than left to the client
// because the tri-state resolution is not something a UI should reimplement —
// that is exactly how two places come to disagree about what -1 means.
func (h *Quota) AdminUsers(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "settings unavailable"})
		return
	}
	limit := quotaUsersDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > quotaUsersMaxLimit {
		limit = quotaUsersMaxLimit
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			offset = n
		}
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))

	// Tenant-confined: SearchUsers takes a raw table, so the caller's scope is
	// what keeps a tenant admin out of every other tenant's account list
	// (tenantstore wraps ListUsers, not this). nil == every tenant, which is
	// single-tenant mode and the supertenant.
	users, total, err := h.Store.SearchUsers(r.Context(), q, scopeProvider(r.Context()), limit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rows := make([]map[string]any, 0, len(users))
	for _, u := range users {
		lim, lerr := h.Service.Limits(r.Context(), u.ID)
		if lerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": lerr.Error()})
			return
		}
		uploadUsed, _, uerr := h.Service.UploadWindowUsed(r.Context(), u.ID)
		if uerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": uerr.Error()})
			return
		}
		rows = append(rows, map[string]any{
			"id":           u.ID,
			"email":        u.Email,
			"display_name": u.DisplayName,
			"role":         u.Role,
			"overrides": map[string]int64{
				"quota_bytes":        u.QuotaBytes,
				"quota_files":        u.QuotaFiles,
				"quota_upload_bytes": u.QuotaUploadBytes,
			},
			"effective": map[string]int64{
				"quota_bytes":  lim.Bytes,
				"quota_files":  lim.Files,
				"upload_bytes": lim.UploadBytes,
			},
			"used_bytes":        u.UsageBytes,
			"used_files":        u.UsageFiles,
			"upload_used_bytes": uploadUsed,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":  rows,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}
