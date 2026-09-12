package handlers_test

/* GET /api/auth/methods — what a signed-in user may know about their own
   sign-in. The admin answer (/api/admin/auth-providers) carries issuers and
   bind credentials and is supertenant-only; this one carries a name and two
   flags, and every user may ask it about themselves. */

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type methodsBody struct {
	Provider       string `json:"provider"`
	ChangePassword bool   `json:"change_password"`
	TOTPEnabled    bool   `json:"totp_enabled"`
}

func askMethods(t *testing.T, h *handlers.AuthSelf, u *model.User) methodsBody {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/auth/methods", nil)
	rec := httptest.NewRecorder()
	h.Methods(rec, req.WithContext(auth.WithUser(req.Context(), u)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out methodsBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func TestAuthMethods_ReportsTheRealmAndWhatItAllows(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	h := handlers.NewAuthSelf(store)

	local, err := store.CreateProvider(ctx, &model.Provider{Slug: "local-realm", Name: "Local", AuthType: model.AuthTypeLocal, Enabled: true})
	require.NoError(t, err)
	sso, err := store.CreateProvider(ctx, &model.Provider{Slug: "sso", Name: "SSO", AuthType: model.AuthTypeOIDC, Enabled: true})
	require.NoError(t, err)

	ada, err := store.CreateUser(ctx, "ada@example.com", "hash", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	ada.ProviderID = &local.ID
	require.Equal(t, methodsBody{Provider: "local", ChangePassword: true}, askMethods(t, h, ada),
		"a local realm may change its own password here")

	ada.TOTPEnabled = true
	require.True(t, askMethods(t, h, ada).TOTPEnabled)

	// A password hash outranks the tenant row, and it has to: `providers.auth_type`
	// defaults to 'oidc' and the seeded `default` tenant never sets it, so every
	// single-tenant install would otherwise hide the password form from an account
	// whose password is exactly what it signs in with.
	ada.ProviderID = &sso.ID
	require.Equal(t, "local", askMethods(t, h, ada).Provider)

	// Without a hash there is nothing to change here, and the realm answers instead.
	ada.PasswordHash = ""
	got := askMethods(t, h, ada)
	require.Equal(t, "oidc", got.Provider)
	require.False(t, got.ChangePassword, "an OIDC account's password lives at its identity provider")

	// Rows predating the provider backfill have no realm at all.
	ada.ProviderID = nil
	ada.PasswordHash = "hash"
	require.Equal(t, "local", askMethods(t, h, ada).Provider)
}

func TestAuthMethods_RefusesAnAnonymousCaller(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	req := httptest.NewRequest(http.MethodGet, "/api/auth/methods", nil)
	rec := httptest.NewRecorder()
	handlers.NewAuthSelf(store).Methods(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
