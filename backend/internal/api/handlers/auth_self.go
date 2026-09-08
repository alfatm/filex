// Package handlers — auth_self.go
//
// Self-service auth endpoints (current user). All routes require an
// authenticated session and act on the principal in the request context.
//
//	GET    /api/auth/me              — current user
//	GET    /api/auth/methods         — how this user signs in, and what they may change
//	PATCH  /api/auth/profile         — update email/username/locale/timezone
//	POST   /api/auth/password        — change password (requires old)
//	GET    /api/auth/sessions        — where this account is signed in
//	DELETE /api/auth/sessions/{id}   — end one of those sessions
//	POST   /api/auth/totp/enroll     — start TOTP enrollment
//	POST   /api/auth/totp/verify     — confirm TOTP enrollment with code
//	POST   /api/auth/totp/disable    — turn TOTP off (password + code)
package handlers

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	qrcode "github.com/skip2/go-qrcode"
	"golang.org/x/crypto/bcrypt"

	"github.com/pquerna/otp/totp"

	"github.com/brf-tech/filex/backend/internal/auth"
	authlocal "github.com/brf-tech/filex/backend/internal/auth/drivers/local"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/identity"
	"github.com/brf-tech/filex/backend/internal/model"
)

// AuthSelf wraps the self-service profile/password/TOTP routes.
type AuthSelf struct {
	Store db.Store
}

// NewAuthSelf constructs the handler.
func NewAuthSelf(store db.Store) *AuthSelf { return &AuthSelf{Store: store} }

// Me returns the authenticated user.
//
// Wire shape mirrors LoginResponse: `{user: {…}}`. The frontend
// auth store reads `me.user`; without the wrapper user.value
// stayed undefined and TopNav fell back to "? —" forever.
func (h *AuthSelf) Me(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

// authMethods is what a signed-in user may know about their own sign-in: the
// realm they belong to, whether that realm lets them change a password here,
// and whether their filex second factor is on. Deliberately not the admin
// answer — /api/admin/auth-providers carries issuers, client ids and bind
// credentials and is supertenant-only. Nothing here is configuration.
type authMethods struct {
	// Provider is the realm's auth type ("local", "oidc", …), which is also
	// the driver name, so the UI can name the sign-in method.
	Provider string `json:"provider"`
	// ChangePassword is the driver's own capability. False for OIDC: the
	// password lives at the identity provider, and a form here would be a lie.
	ChangePassword bool `json:"change_password"`
	// TOTPEnabled is filex's own second factor. It only means anything on a
	// local realm; an OIDC user's second step belongs to their provider.
	TOTPEnabled bool `json:"totp_enabled"`
}

// Methods answers `GET /api/auth/methods` for the caller.
func (h *AuthSelf) Methods(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	out := authMethods{Provider: h.realmOf(r, u), TOTPEnabled: u.TOTPEnabled}
	if driver, err := auth.Get(out.Provider); err == nil {
		out.ChangePassword = driver.Capabilities().ChangePassword
	}
	writeJSON(w, http.StatusOK, out)
}

// realmOf names the auth type this user signs in with.
//
// The password hash comes FIRST, ahead of the tenant row, because the tenant
// row lies on the common install: `providers.auth_type` defaults to 'oidc'
// (migration 00014) and the seeded `default` tenant is inserted without one,
// so every single-tenant server claims OIDC while its admin signs in with a
// password. The hash is the honest answer to the question the caller is really
// asking — whether POST /api/auth/password can work for this account — since
// that endpoint does nothing but compare against this hash.
//
// Without a hash the tenant's auth_type is the best evidence there is, and an
// install predating the provider backfill has neither.
func (h *AuthSelf) realmOf(r *http.Request, u *model.User) string {
	if u.PasswordHash != "" {
		return model.AuthTypeLocal
	}
	if u.ProviderID != nil && h.Store != nil {
		if p, err := h.Store.GetProvider(r.Context(), *u.ProviderID); err == nil && p.AuthType != "" {
			return p.AuthType
		}
	}
	if enabled := auth.Enabled(); len(enabled) > 0 {
		return enabled[0].Name()
	}
	return ""
}

type profileReq struct {
	Email *string `json:"email,omitempty"`
	// Username is the short login name used by the connection protocols
	// (migration 00025). Unlike the fields around it this one is REJECTED
	// rather than silently ignored when invalid or taken: it is a name other
	// people can see is unavailable, and a form that appears to save a name
	// the account did not get is worse than an error.
	Username    *string `json:"username,omitempty"`
	DisplayName *string `json:"display_name,omitempty"`
	// FullName and JobTitle are the optional profile fields of migration 00035. Absent means
	// "leave as it was"; an empty string means "clear it".
	FullName *string `json:"full_name,omitempty"`
	JobTitle *string `json:"job_title,omitempty"`
	Locale   *string `json:"locale,omitempty"`
	Timezone *string `json:"timezone,omitempty"`
	// AvatarURL is the profile picture — a small data:image/… URI (what the
	// profile page's file picker produces) or an http(s)/site-relative URL.
	// An explicit "" removes it. Absent = leave the current one alone.
	AvatarURL *string `json:"avatar_url,omitempty"`
}

// avatarMaxBytes caps an inline profile picture. Far below the branding logo's
// 256 KB on purpose: the avatar rides inside every presence frame the live
// collaboration socket broadcasts, so a heavy one is paid for again on every
// join, leave and focus change — not once per page like a logo. The profile
// page downscales to 160px before encoding, which lands comfortably under this.
const avatarMaxBytes = 48 * 1024

// UpdateProfile patches the current user's profile fields.
func (h *AuthSelf) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	var req profileReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.Email != nil && *req.Email != "" {
		_ = h.Store.UpdateUserEmail(r.Context(), u.ID, strings.ToLower(strings.TrimSpace(*req.Email)))
	}
	if req.Username != nil {
		name := identity.Normalize(*req.Username)
		if err := identity.Validate(name); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		// Check before writing so the common case gets a clear 409 instead of
		// a driver-specific unique-constraint string. The index is still the
		// real guard: a racing claim fails the UPDATE below and is reported.
		if other, err := h.Store.GetUserByUsername(r.Context(), name); err == nil && other != nil && other.ID != u.ID {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "that username is taken"})
			return
		}
		if name != u.Username {
			if err := h.Store.SetUserUsername(r.Context(), u.ID, name); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "that username is taken"})
				return
			}
		}
	}
	if req.DisplayName != nil {
		_ = h.Store.UpdateUserDisplayName(r.Context(), u.ID, strings.TrimSpace(*req.DisplayName))
	}
	// Optional profile fields: written only when the caller sent the key, and an empty string is a
	// legitimate value — it is how a job title is removed.
	if req.FullName != nil || req.JobTitle != nil {
		full, title := u.FullName, u.JobTitle
		if req.FullName != nil {
			full = strings.TrimSpace(*req.FullName)
		}
		if req.JobTitle != nil {
			title = strings.TrimSpace(*req.JobTitle)
		}
		if err := h.Store.UpdateUserProfileFields(r.Context(), u.ID, full, title); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if req.AvatarURL != nil {
		avatar := strings.TrimSpace(*req.AvatarURL)
		// Reject loudly rather than silently dropping the picture: the user is
		// looking at an upload they believe worked.
		if err := validateImageRef("avatar_url", avatar, avatarMaxBytes); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := h.Store.UpdateUserAvatar(r.Context(), u.ID, avatar); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if req.Locale != nil || req.Timezone != nil {
		l := u.Locale
		tz := u.Timezone
		if req.Locale != nil {
			l = *req.Locale
		}
		if req.Timezone != nil {
			tz = *req.Timezone
		}
		_ = h.Store.UpdateUserLocale(r.Context(), u.ID, l, tz)
	}
	updated, _ := h.Store.GetUser(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, updated)
}

// sessionView is one row of GET /api/auth/sessions: where a sign-in came from and how long it
// still has. The session token itself never leaves the server — it IS the credential, and a list
// of live credentials is exactly what an XSS would want to read.
type sessionView struct {
	ID        int64     `json:"id"`
	IP        string    `json:"ip,omitempty"`
	UserAgent string    `json:"user_agent,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	// Current marks the session this very request is authenticated by — the one row that must
	// not be offered an "end session" button, because ending it is signing out.
	Current bool `json:"current"`
}

// Sessions answers `GET /api/auth/sessions` with the caller's own unexpired sign-ins.
//
// Scoped to the caller by construction: the user id comes from the request context, never from a
// parameter, so there is no id to tamper with. A caller authenticated by an API token instead of
// a browser session has no cookie, so no row comes back marked current.
func (h *AuthSelf) Sessions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	rows, err := h.Store.ListSessionsForUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	current := currentSessionToken(r)
	out := make([]sessionView, 0, len(rows))
	for _, s := range rows {
		out = append(out, sessionView{
			ID:        s.ID,
			IP:        s.IP,
			UserAgent: s.UserAgent,
			CreatedAt: s.CreatedAt,
			ExpiresAt: s.ExpiresAt,
			Current:   current != "" && s.Token == current,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// RevokeSession ends one of the caller's other sessions.
//
//	DELETE /api/auth/sessions/{id}
//
// The current session is refused rather than deleted: "sign out everywhere but here" is what this
// surface is for, and a button that silently signs the user out of the tab they are looking at
// would be indistinguishable from a bug.
func (h *AuthSelf) RevokeSession(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad session id"})
		return
	}
	rows, err := h.Store.ListSessionsForUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	var target *model.Session
	for _, s := range rows {
		if s.ID == id {
			target = s
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	if token := currentSessionToken(r); token != "" && target.Token == token {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "that is the session you are calling from",
			"hint":  "sign out to end this one",
		})
		return
	}
	if _, err := h.Store.DeleteUserSession(r.Context(), u.ID, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// currentSessionToken is the browser session this request rides on, or "" for any other way in.
func currentSessionToken(r *http.Request) string {
	c, err := r.Cookie(authlocal.SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

type passwordReq struct {
	// OldPassword is the documented field. CurrentPassword is a defensive
	// alias — different frontends (and earlier builds of this SPA) posted
	// `current_password`; accept either so a field-name mismatch can never
	// silently turn the old-password check into a no-op.
	OldPassword     string `json:"old_password"`
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// ChangePassword verifies the old password then writes a new bcrypt hash
// and revokes other sessions to force re-login.
func (h *AuthSelf) ChangePassword(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	var req passwordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if len(req.NewPassword) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new password too short (min 8)"})
		return
	}
	oldPassword := req.OldPassword
	if oldPassword == "" {
		oldPassword = req.CurrentPassword
	}
	cur, err := h.Store.GetUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cur.PasswordHash), []byte(oldPassword)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "old password incorrect"})
		return
	}
	hash, err := authlocal.HashPassword(req.NewPassword)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := h.Store.UpdateUserPassword(r.Context(), u.ID, hash); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Revoke other sessions; keep current.
	if c, err := r.Cookie(authlocal.SessionCookieName); err == nil {
		_ = h.Store.DeleteSessionsForUser(r.Context(), u.ID, c.Value)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// TotpEnroll generates a new pending secret + QR SVG + recovery codes.
//
// The user must call /totp/verify with a valid code from their authenticator
// app to actually activate it; this endpoint does NOT enable TOTP yet.
func (h *AuthSelf) TotpEnroll(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	secret, err := generateTotpSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	codes := generateRecoveryCodes(10)
	if err := h.Store.SetTotpPendingSecret(r.Context(), u.ID, secret, codes); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	otpURL := fmt.Sprintf(
		"otpauth://totp/filex:%s?secret=%s&issuer=filex&algorithm=SHA1&digits=6&period=30",
		u.Email, secret,
	)
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":         secret,
		"otpauth_url":    otpURL,
		"qr_svg":         renderQRSVG(otpURL),
		"recovery_codes": codes,
	})
}

type totpVerifyReq struct {
	Code string `json:"code"`
}

// TotpVerify activates TOTP if the given code matches the pending secret.
func (h *AuthSelf) TotpVerify(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	var req totpVerifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	cur, err := h.Store.GetUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if cur.TOTPPendingSecret == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no pending TOTP enrollment"})
		return
	}
	if !verifyTOTP(cur.TOTPPendingSecret, req.Code) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid code"})
		return
	}
	if err := h.Store.ActivateTotp(r.Context(), u.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "totp_enabled": true})
}

type totpDisableReq struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

// TotpDisable clears the user's TOTP secret if both password + code match.
func (h *AuthSelf) TotpDisable(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	var req totpDisableReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	cur, err := h.Store.GetUser(r.Context(), u.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cur.PasswordHash), []byte(req.Password)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "password incorrect"})
		return
	}
	if !cur.TOTPEnabled || !verifyTOTP(cur.TOTPSecret, req.Code) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid code"})
		return
	}
	if err := h.Store.ClearTotp(r.Context(), u.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "totp_enabled": false})
}

// generateTotpSecret produces a base32-encoded 20-byte secret (RFC 4648).
func generateTotpSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf), nil
}

// generateRecoveryCodes produces n random 10-char alphanumeric codes.
func generateRecoveryCodes(n int) []string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]string, n)
	for i := range out {
		buf := make([]byte, 10)
		_, _ = rand.Read(buf)
		s := make([]byte, 10)
		for j := range s {
			s[j] = alphabet[int(buf[j])%len(alphabet)]
		}
		out[i] = string(s[:5]) + "-" + string(s[5:])
	}
	return out
}

// verifyTOTP validates a user-supplied one-time code against the stored
// base32 secret using RFC 6238 (SHA1, 6 digits, 30s period). pquerna's
// totp.Validate applies a ±1 period skew to tolerate clock drift and
// decodes no-padding base32 secrets (matching generateTotpSecret above).
func verifyTOTP(secret, code string) bool {
	code = strings.TrimSpace(code)
	if secret == "" || code == "" {
		return false
	}
	return totp.Validate(code, secret)
}

// renderQRSVG renders the otpauth:// URI as a self-contained SVG QR code so
// the admin SPA (which v-html's the response) can display it without an
// extra request. Modules are drawn as 1×1 rects in a viewBox sized to the
// matrix; the SVG scales crisply to any width. On encode failure we fall
// back to a tiny notice SVG rather than failing enrollment outright — the
// caller also returns secret + otpauth_url so the user can still proceed.
func renderQRSVG(payload string) string {
	qr, err := qrcode.New(payload, qrcode.Medium)
	if err != nil {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">` +
			`<rect width="180" height="180" fill="#fff"/>` +
			`<text x="90" y="92" text-anchor="middle" font-family="monospace" font-size="9" fill="#900">QR encode error</text></svg>`
	}
	bitmap := qr.Bitmap()
	n := len(bitmap)
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" shape-rendering="crispEdges" viewBox="0 0 %d %d">`, n, n)
	b.WriteString(`<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="`)
	for y, row := range bitmap {
		for x, dark := range row {
			if dark {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x, y)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String()
}
