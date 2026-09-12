package handlers

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/perm"
)

// Per-role OPERATION permissions (internal/perm, migration 00044).
//
// The service travels on the request context rather than on each handler
// struct. Thirteen operations are enforced across ten handlers, and hanging a
// field + an Attach method off every one of them would have meant ten places to
// forget when the eleventh handler is written — while the check itself is a
// single line at the top of a function either way.
//
// ⚠ This is an ADDITIONAL gate, never a replacement. Every existing ACL /
// read-only / quota check stays exactly where it is: perm answers "may this
// ROLE do this kind of thing at all", the ACL answers "may this PERSON touch
// this item", and a request needs both.

type permCtxKey struct{}

// PermMiddleware puts the permission service on every request context. Mounted
// once at the router root, before auth: the service is only consulted from
// inside handlers, by which time the auth middleware has resolved the caller.
func PermMiddleware(svc *perm.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(WithPermService(r.Context(), svc)))
		})
	}
}

// WithPermService returns ctx carrying svc.
func WithPermService(ctx context.Context, svc *perm.Service) context.Context {
	return context.WithValue(ctx, permCtxKey{}, svc)
}

// PermServiceFrom returns the request's permission service, or nil.
func PermServiceFrom(ctx context.Context) *perm.Service {
	svc, _ := ctx.Value(permCtxKey{}).(*perm.Service)
	return svc
}

// permAllowed answers the question without writing anything.
//
// It allows in three cases, each on purpose:
//   - no service wired — a hand-assembled Deps degrades to the pre-feature
//     behaviour instead of refusing every write;
//   - no user on the context — the credential-free public surfaces (share
//     link, file-drop, upload ticket) have no role to consult, and their own
//     token already fixed what they may do;
//   - the caller is an admin — the wildcard, without a store round-trip.
//
// A lookup ERROR allows too, and logs. The alternative is an install where one
// unreadable roles row stops every upload in the product, which is a far worse
// failure than one over-permitted request while an operator reads the log.
func permAllowed(r *http.Request, op string) bool {
	ctx := r.Context()
	svc := PermServiceFrom(ctx)
	if svc == nil {
		return true
	}
	u := auth.UserFrom(ctx)
	if u == nil {
		return true
	}
	if u.IsAdmin() {
		return true
	}
	ok, err := svc.Allowed(ctx, u.Role, op)
	if err != nil {
		slog.Warn("perm: role lookup failed, allowing",
			slog.String("role", u.Role), slog.String("op", op), slog.String("err", err.Error()))
		return true
	}
	return ok
}

// requirePerm is the one line an enforcement point adds. It returns true when
// the request may proceed; otherwise it has already written the 403 and the
// caller must return.
//
// 403 and not 401: the credential is fine and the route exists — what is
// refused is this ROLE doing this KIND of thing. `code` and `op` are there so a
// client can say "your role may not delete files" instead of the generic
// "forbidden" it shows for an ACL denial, and so the two never get confused in
// a support thread.
func requirePerm(w http.ResponseWriter, r *http.Request, op string) bool {
	if permAllowed(r, op) {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]string{
		"error": "your role may not do this",
		"code":  "ROLE_FORBIDDEN",
		"op":    op,
	})
	return false
}
