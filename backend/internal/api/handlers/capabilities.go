package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/brf-tech/filex/backend/internal/auth"
	authlocal "github.com/brf-tech/filex/backend/internal/auth/drivers/local"
	"github.com/brf-tech/filex/backend/internal/auth/drivers/multioidc"
	"github.com/brf-tech/filex/backend/internal/capability"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/e2e"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/share"
)

// Capabilities exposes /api/capabilities.
type Capabilities struct {
	Service *capability.Service
	// Store + MultiTenant power the per-tenant branding block: in multi-tenant
	// mode the (pre-auth, host-resolved) capabilities answer carries only THIS
	// host's tenant identity — never the existence of other tenants
	// (docs/MULTI-TENANCY.md §12 + isolation checklist).
	Store       db.Store
	MultiTenant bool
	/* kimlik:e3 cloud */
	// CloudEnabled mirrors FILEX_CLOUD (set by BuildRouter only when the flag
	// is on). While false — the default — the capabilities payload carries NO
	// cloud field at all, keeping the flag-off wire format byte-identical.
	CloudEnabled bool
	/* wiring:e2 */
	// E2EEscrow is the installation escrow PUBLIC key, or nil when escrow is
	// off. It is published deliberately: the browser needs it to wrap a new
	// encrypted folder's master key to the operator, and a user about to
	// create such a folder is entitled to know, before they create it, that
	// their operator holds a second key to it.
	E2EEscrow *e2e.EscrowKey
}

// NewCapabilities constructs a Capabilities handler.
func NewCapabilities(svc *capability.Service, store db.Store, multiTenant bool) *Capabilities {
	return &Capabilities{Service: svc, Store: store, MultiTenant: multiTenant}
}

// Get returns the runtime feature snapshot.
//
// We emit BOTH the rich nested shape (filex-core admin SPA) AND a flat
// alias set (legacy embed.js + filex-core SFC fallback expected:
// `ffmpeg / ghostscript / libreoffice / max_chunk_mb / upload_limit_mb /
// onlyoffice_url / drawio_url`). Cheap to ship both — keeps the SFC
// happy without breaking the existing admin UI bindings.
func (h *Capabilities) Get(w http.ResponseWriter, r *http.Request) {
	c, err := h.Service.Get(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Build flat aliases.
	const mb = int64(1024 * 1024)
	flat := map[string]any{
		"ffmpeg":       c.Thumbs.Video,
		"imagemagick":  c.Thumbs.ImageMagick,
		"ghostscript":  c.Thumbs.PDF,
		"libreoffice":  c.Thumbs.Office,
		"max_chunk_mb": int64(0),
		"upload_limit_mb": func() int64 {
			if c.MaxUploadSize <= 0 {
				return 0
			}
			return c.MaxUploadSize / mb
		}(),
		"onlyoffice_url": "",
		"drawio_url":     "",
		"convert_url":    "",
	}
	if c.ChunkSize > 0 {
		flat["max_chunk_mb"] = c.ChunkSize / mb
	}
	if oo, ok := c.External["onlyoffice"]; ok && oo.Enabled {
		flat["onlyoffice_url"] = oo.URL
	}
	if dr, ok := c.External["drawio"]; ok && dr.Enabled {
		flat["drawio_url"] = dr.URL
	}
	if cv, ok := c.External["convert"]; ok && cv.Enabled {
		flat["convert_url"] = cv.URL
	}

	// Marshal the rich snapshot to a generic map so we can layer the
	// flat aliases on top (no struct tag wrestling).
	raw, _ := json.Marshal(c)
	merged := map[string]any{}
	_ = json.Unmarshal(raw, &merged)
	for k, v := range flat {
		// Don't clobber an existing nested field of the same name.
		if _, exists := merged[k]; !exists {
			merged[k] = v
		}
	}

	// Per-tenant branding: identify only the tenant this host belongs to.
	if h.MultiTenant && h.Store != nil {
		if p, _ := h.Store.GetProviderByHost(r.Context(), multioidc.RequestHost(r)); p != nil {
			merged["tenant"] = map[string]any{"slug": p.Slug, "name": p.Name}
		}
	}
	/* kimlik:e3 cloud */
	if h.CloudEnabled {
		merged["cloud"] = map[string]any{"enabled": true, "signup_url": "/api/cloud/signup"}
	}
	// The longest life a new share link may be given (0 = no ceiling). The
	// share dialog reads it to offer only expiries the server will honour,
	// instead of letting someone pick "30 days" and get 7.
	if h.Store != nil {
		merged["share_max_ttl_days"] = share.NewService(h.Store).MaxTTLDays(r.Context())
	}

	// Who is asking — a person, or an integration (migration 00030)?
	//
	// The explorer needs this to decide whether to draw the identity-bearing
	// surfaces (its own API keys, Recent, Starred, Shared with me). It cannot
	// work it out for itself: an API token authenticates AS its owner, so from
	// the browser's side a shared embed token and a person's own token look
	// identical, and in the embeds we run ONE proxy-injected token serves every
	// visitor.
	//
	// The field is caller_KIND, not token_kind, because the answer must cover
	// the cookie/OIDC case too — a session has no token at all, and it is
	// always a person. Same reason the fallback is "user": /api/files/
	// capabilities is a public route, so an anonymous pre-login fetch (the
	// share and drop pages make one) must not read as an app.
	//
	// ⚠ Suppression is per-KIND, never per-role. A viewer is still a person.
	callerKind := model.TokenKindUser
	if auth.TokenFrom(r.Context()).IsApp() {
		callerKind = model.TokenKindApp
	}
	merged["caller_kind"] = callerKind

	// What this CALLER's role may do (internal/perm, migration 00044).
	// Expanded — an admin gets the whole catalogue rather than `["*"]`, so the
	// client tests membership and never has to know the wildcard exists.
	// Anonymous (the login screen, the public share/drop pages) gets an empty
	// list: there is no role to report, and an empty list is the honest answer.
	merged["permissions"] = h.callerPermissions(r)

	/* wiring:e2 — say plainly whether this installation holds a second key.
	 * Fixed at install (FILEX_INSTALLATION_E2E_ESCROW_KEY) and immutable
	 * afterwards, so this answer never changes for a running installation. */
	esc := map[string]any{"enabled": false}
	if h.E2EEscrow != nil {
		esc = map[string]any{
			"enabled":    true,
			"kid":        h.E2EEscrow.KID,
			"alg":        e2e.EscrowAlg,
			"public_key": h.E2EEscrow.SPKI,
		}
	}
	merged["e2e_escrow"] = esc
	writeJSON(w, http.StatusOK, merged)
}

// callerPermissions resolves the operation list of whoever is asking.
//
// ⚠ This route is PUBLIC (see routes.go): it carries auth.AnnotateToken only,
// which names the token but never resolves a user, precisely so a disabled
// account's stale cookie cannot 403 the login screen's own probe. So the role
// is read from what is ALREADY on the request — the context user, the session
// the cookie names, or the annotated API token's owner — with READ-ONLY store
// lookups and never by running the driver chain.
//
// Calling auth.Enabled()[i].Authenticate(r) here was wrong twice over: the
// drivers are not side-effect free (apitoken writes TouchAPIToken, so a public
// probe billed a token as used; proxyheader AUTO-PROVISIONS an account, so a
// GET on a public route could create a user), and they do not check u.Enabled
// — that is the middleware's job, and this route has no middleware — so a
// disabled account got its full permission list back. Anonymous, unresolvable
// and disabled all answer the empty list, which is the documented answer.
func (h *Capabilities) callerPermissions(r *http.Request) []string {
	ctx := r.Context()
	svc := PermServiceFrom(ctx)
	if svc == nil {
		return []string{}
	}
	u := h.callerUser(r)
	// ⚠ u.Enabled is checked HERE, not by a middleware this route does not
	// have: a disabled account's stale cookie must read as anonymous rather
	// than get its old role's permission list back.
	if u == nil || !u.Enabled {
		return []string{}
	}
	role := u.Role
	if role == "" {
		return []string{}
	}
	ops, err := svc.Permissions(ctx, role)
	if err != nil || ops == nil {
		return []string{}
	}
	return ops
}

// sessionToken is the session the request presents, however it presents it —
// the cookie, or a Bearer header, exactly the two the local driver reads. An
// empty string means no session was offered.
func sessionToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, authlocal.BearerPrefix) {
		return strings.TrimSpace(h[len(authlocal.BearerPrefix):])
	}
	if c, err := r.Cookie(authlocal.SessionCookieName); err == nil {
		return c.Value
	}
	return ""
}

// callerUser identifies the requester with reads only: the context user if an
// earlier chain resolved one, else the account behind the session cookie, else
// the annotated API token's owner. nil means "anonymous as far as this route is
// concerned", which is a legitimate answer here and never an error.
//
// The session is looked up straight from the store rather than through the
// local driver so that nothing in the driver chain runs; GetSessionByToken
// already refuses an expired token. The token is checked last because a request
// carrying both is a person using the panel.
func (h *Capabilities) callerUser(r *http.Request) *model.User {
	ctx := r.Context()
	if u := auth.UserFrom(ctx); u != nil {
		return u
	}
	if h.Store == nil {
		return nil
	}
	if sessTok := sessionToken(r); sessTok != "" {
		if sess, serr := h.Store.GetSessionByToken(ctx, sessTok); serr == nil && sess != nil {
			if u, uerr := h.Store.GetUser(ctx, sess.UserID); uerr == nil {
				return u
			}
		}
	}
	if tok := auth.TokenFrom(ctx); tok != nil && tok.UserID > 0 {
		if u, err := h.Store.GetUser(ctx, tok.UserID); err == nil {
			return u
		}
	}
	return nil
}
