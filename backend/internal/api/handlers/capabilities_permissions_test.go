package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	apitoken "github.com/brf-tech/filex/backend/internal/auth/drivers/apitoken"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/perm"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// capsPermissions reads the permissions array out of a /api/files/capabilities
// body. A missing array is a failure: the field is always emitted, empty or
// not, and a client that has to tell absence from [] has already lost.
func capsPermissions(t *testing.T, raw string) []string {
	t.Helper()
	body := map[string]any{}
	require.NoError(t, json.Unmarshal([]byte(raw), &body))
	arr, ok := body["permissions"].([]any)
	require.True(t, ok, "no permissions array in %s", raw)
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		out = append(out, v.(string))
	}
	return out
}

// TestCapabilities_PermissionsHaveNoSideEffects — the PUBLIC capabilities route
// was AUTHENTICATING.
//
// callerPermissions looped over auth.Enabled() calling d.Authenticate(r), and
// two of those drivers are not side-effect free: apitoken writes
// TouchAPIToken, so an unauthenticated probe billed a token as used, and
// proxyheader auto-provisions an account, so a GET on a public route could
// CREATE a user. The route deliberately carries AnnotateToken only (which
// documents "no TouchAPIToken: describing yourself is not use").
//
// The role now comes from what is already on the request, and the token's
// last_used is the measurable proof that no driver ran.
func TestCapabilities_PermissionsHaveNoSideEffects(t *testing.T) {
	srv, _, store := testutil.NewTestServer(t)
	ctx := context.Background()

	u := testutil.SeedUser(t, store, "probe@test.local", "ProbePass1!")
	plain := seedKindToken(t, store, u.ID, model.TokenKindUser)

	before, err := store.GetAPITokenByHash(ctx, apitoken.HashToken(plain))
	require.NoError(t, err)
	require.Nil(t, before.LastUsedAt, "fixture: a fresh token has never been used")

	status, body := callWithToken(t, http.MethodGet, srv.URL+"/api/files/capabilities", plain, "")
	require.Equal(t, http.StatusOK, status, body)

	// The token still identifies its owner — the answer must not have been
	// bought by dropping the feature.
	require.Contains(t, capsPermissions(t, body), perm.OpDownload,
		"a token caller must still get its owner's role permissions")

	after, err := store.GetAPITokenByHash(ctx, apitoken.HashToken(plain))
	require.NoError(t, err)
	require.Nil(t, after.LastUsedAt,
		"a public capabilities probe must not write last_used on the presented token")
}

// TestCapabilities_PermissionsByCaller — anonymous gets [], a signed-in user
// gets its role's set, and a DISABLED account gets [].
//
// The disabled case is the disclosure half of the same defect: the drivers do
// not check u.Enabled (the middleware does, and this route has none), so a
// revoked account's stale cookie read back its old role's whole permission
// list on a route built to be safe for exactly that cookie.
func TestCapabilities_PermissionsByCaller(t *testing.T) {
	srv, _, store := testutil.NewTestServer(t)
	ctx := context.Background()
	url := srv.URL + "/api/files/capabilities"

	t.Run("anonymous gets the empty list", func(t *testing.T) {
		status, body := callWithToken(t, http.MethodGet, url, "", "")
		require.Equal(t, http.StatusOK, status, body)
		require.Empty(t, capsPermissions(t, body),
			"there is no role to report for an anonymous caller")
	})

	t.Run("signed-in user gets its role's set", func(t *testing.T) {
		testutil.SeedUser(t, store, "signedin@test.local", "SignedIn1!")
		client := freshClient(t)
		testutil.LoginAs(t, srv, client, "signedin@test.local", "SignedIn1!")

		resp, err := client.Get(url)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw := map[string]any{}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&raw))
		got, _ := raw["permissions"].([]any)
		require.NotEmpty(t, got, "a session caller must keep its permission list")
		require.Contains(t, got, perm.OpDownload, "the `user` role's own set")
	})

	t.Run("disabled account gets the empty list", func(t *testing.T) {
		dead := testutil.SeedUser(t, store, "dead@test.local", "DeadPass1!")
		client := freshClient(t)
		testutil.LoginAs(t, srv, client, "dead@test.local", "DeadPass1!")
		// Disabled AFTER the cookie was issued — the stale-cookie case this
		// route exists to answer without a 403.
		require.NoError(t, store.SetUserEnabled(ctx, dead.ID, false))

		resp, err := client.Get(url)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw := map[string]any{}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&raw))
		require.Equal(t, http.StatusOK, resp.StatusCode,
			"the probe must still answer 200: this route cannot 403")
		got, _ := raw["permissions"].([]any)
		require.Empty(t, got, "a disabled account must not read back its old permissions")

		// Same for a token the disabled account still holds.
		plain := seedKindToken(t, store, dead.ID, model.TokenKindUser)
		status, body := callWithToken(t, http.MethodGet, url, plain, "")
		require.Equal(t, http.StatusOK, status, body)
		require.Empty(t, capsPermissions(t, body),
			"a disabled owner's token must not read back permissions either")
	})
}
