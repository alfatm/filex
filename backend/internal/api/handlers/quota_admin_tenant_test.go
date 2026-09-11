package handlers_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/testutil"
)

// quotaUserEmails pulls the e-mail column out of /api/admin/quotas/users.
func quotaUserEmails(t *testing.T, body map[string]any) []string {
	t.Helper()
	rows, ok := body["users"].([]any)
	require.True(t, ok, "no users array in %v", body)
	out := make([]string, 0, len(rows))
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		require.True(t, ok)
		out = append(out, row["email"].(string))
	}
	return out
}

// TestAdminQuotaUsers_TenantConfined — /api/admin/quotas/users listed EVERY
// tenant's accounts.
//
// The row carries id, e-mail, display name, role and both usage counters, so a
// tenant admin calling ?q=@ got a directory of the whole installation, the
// supertenant's admins included. The listing goes through SearchUsers, which
// tenantstore does not wrap (it wraps ListStorages / ListEnabledStorages /
// ListUsers only — see the tenantGate comment in users.go), so the confinement
// has to be passed in as the caller's provider.
func TestAdminQuotaUsers_TenantConfined(t *testing.T) {
	srv, client, store := multiTenantServer(t)

	providerA, adminA, passA := seedTenant(t, store, "diyetlif", "admin@diyetlif.test", false)
	providerB, _, _ := seedTenant(t, store, "arasboya", "admin@arasboya.test", false)
	seedUserIn(t, store, providerA, "user@diyetlif.test")
	seedUserIn(t, store, providerB, "user@arasboya.test")

	testutil.LoginAs(t, srv, client, adminA, passA)

	status, body := doJSON(t, client, http.MethodGet, srv.URL+"/api/admin/quotas/users?q=@", nil)
	require.Equal(t, http.StatusOK, status, "body: %v", body)

	got := quotaUserEmails(t, body)
	require.ElementsMatch(t, []string{"admin@diyetlif.test", "user@diyetlif.test"}, got,
		"a tenant admin must not see another tenant's accounts")
	require.NotContains(t, got, "user@arasboya.test")
	require.NotContains(t, got, "admin@arasboya.test")
	// The count drives "showing N of M"; a total counted over every tenant
	// leaks the installation's size even when the rows are filtered.
	require.EqualValues(t, len(got), body["total"],
		"total must count the confined set, not every tenant")
}

// TestAdminQuotaUsers_SupertenantSeesAll — the operator keeps the whole table;
// confinement must not cost them the cross-tenant repair view.
func TestAdminQuotaUsers_SupertenantSeesAll(t *testing.T) {
	srv, client, store := multiTenantServer(t)

	email, password := testutil.SeedAdmin(t, store) // provider 1 = supertenant
	providerA, _, _ := seedTenant(t, store, "diyetlif", "admin@diyetlif.test", false)
	providerB, _, _ := seedTenant(t, store, "arasboya", "admin@arasboya.test", false)
	seedUserIn(t, store, providerA, "user@diyetlif.test")
	seedUserIn(t, store, providerB, "user@arasboya.test")

	testutil.LoginAs(t, srv, client, email, password)

	status, body := doJSON(t, client, http.MethodGet, srv.URL+"/api/admin/quotas/users?q=@", nil)
	require.Equal(t, http.StatusOK, status, "body: %v", body)

	got := quotaUserEmails(t, body)
	for _, want := range []string{
		"admin@diyetlif.test", "user@diyetlif.test",
		"admin@arasboya.test", "user@arasboya.test",
	} {
		require.Contains(t, got, want, "the supertenant must still see every tenant")
	}
	require.EqualValues(t, len(got), body["total"])
}
