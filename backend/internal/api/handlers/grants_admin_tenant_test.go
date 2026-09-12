package handlers_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// TestAdminGrants_TenantGate — PATCH/DELETE /api/admin/grants/{id} resolved a
// grant by BARE ID.
//
// AdminList filters by scope and AdminCreate checks the target storage, but the
// two mutations did neither: a tenant admin could PATCH
// /api/admin/grants/17?principal=group {"level":"owner"} and promote another
// tenant's group on another tenant's storage, or DELETE the row and revoke
// access there. Grant ids are dense integers, so finding one is enumeration,
// not luck.
//
// Out-of-tenant answers 404, not 403 — the same no-exists-oracle rule the
// group gate and the user gate follow.
func TestAdminGrants_TenantGate(t *testing.T) {
	srv, client, store := multiTenantServer(t)
	ctx := context.Background()

	// Tenant A (the attacker) and tenant B (the victim), one storage each.
	providerA, adminA, passA := seedTenant(t, store, "diyetlif", "admin@diyetlif.test", false)
	providerB, _, _ := seedTenant(t, store, "arasboya", "admin@arasboya.test", false)
	storageA := seedStorage(t, store, "diyetlif-drive", true)
	storageB := seedStorage(t, store, "arasboya-drive", true)
	require.NoError(t, store.LinkProviderStorage(ctx, providerA, storageA.ID))
	require.NoError(t, store.LinkProviderStorage(ctx, providerB, storageB.ID))

	// A user grant and a group grant, both on tenant B's storage.
	victim := seedSharedUser(t, store, "victim@arasboya.test", "VictimPass1!")
	require.NoError(t, store.SetUserProvider(ctx, victim.ID, providerB, ""))
	userGrant, err := store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: storageB.ID, PathPrefix: "Belgeler", IsDir: true,
		UserID: victim.ID, Level: model.GrantViewer,
	})
	require.NoError(t, err)

	pb := providerB
	victimGroup, err := store.CreateGroup(ctx, &model.Group{Name: "arasboya-ekip", ProviderID: &pb})
	require.NoError(t, err)
	groupGrant, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
		StorageID: storageB.ID, PathPrefix: "Belgeler", IsDir: true,
		GroupID: victimGroup.ID, Level: model.GrantViewer,
	})
	require.NoError(t, err)

	testutil.LoginAs(t, srv, client, adminA, passA)

	userURL := srv.URL + "/api/admin/grants/" + itoa(userGrant.ID)
	groupURL := srv.URL + "/api/admin/grants/" + itoa(groupGrant.ID) + "?principal=group"

	t.Run("cannot re-level another tenant's user grant", func(t *testing.T) {
		status, body := doJSON(t, client, http.MethodPatch, userURL, map[string]any{
			"level": model.GrantOwner,
		})
		require.Equal(t, http.StatusNotFound, status, "body: %v", body)

		// Status alone is not proof — measure the row.
		after, err := store.GetFileGrant(ctx, userGrant.ID)
		require.NoError(t, err)
		require.NotNil(t, after)
		require.Equal(t, model.GrantViewer, after.Level,
			"privilege escalation: the refused PATCH re-levelled the grant anyway")
	})

	t.Run("cannot re-level another tenant's group grant", func(t *testing.T) {
		status, body := doJSON(t, client, http.MethodPatch, groupURL, map[string]any{
			"level": model.GrantOwner,
		})
		require.Equal(t, http.StatusNotFound, status, "body: %v", body)

		after, err := store.GetFileGroupGrant(ctx, groupGrant.ID)
		require.NoError(t, err)
		require.NotNil(t, after)
		require.Equal(t, model.GrantViewer, after.Level,
			"privilege escalation: another tenant's group was promoted")
	})

	t.Run("cannot revoke another tenant's user grant", func(t *testing.T) {
		status, body := doJSON(t, client, http.MethodDelete, userURL, nil)
		require.Equal(t, http.StatusNotFound, status, "body: %v", body)

		after, err := store.GetFileGrant(ctx, userGrant.ID)
		require.NoError(t, err)
		require.NotNil(t, after, "the grant must survive a refused DELETE")
	})

	t.Run("cannot revoke another tenant's group grant", func(t *testing.T) {
		status, body := doJSON(t, client, http.MethodDelete, groupURL, nil)
		require.Equal(t, http.StatusNotFound, status, "body: %v", body)

		after, err := store.GetFileGroupGrant(ctx, groupGrant.ID)
		require.NoError(t, err)
		require.NotNil(t, after, "the grant must survive a refused DELETE")
	})

	// The gate must not break the same-tenant admin it is protecting: a grant
	// on tenant A's own storage is still editable and revocable.
	t.Run("own tenant's grants still manageable", func(t *testing.T) {
		mine := seedSharedUser(t, store, "user@diyetlif.test", "UserPass1!")
		require.NoError(t, store.SetUserProvider(ctx, mine.ID, providerA, ""))
		own, err := store.CreateFileGrant(ctx, &model.FileGrant{
			StorageID: storageA.ID, PathPrefix: "Projeler", IsDir: true,
			UserID: mine.ID, Level: model.GrantViewer,
		})
		require.NoError(t, err)

		url := srv.URL + "/api/admin/grants/" + itoa(own.ID)
		status, body := doJSON(t, client, http.MethodPatch, url, map[string]any{
			"level": model.GrantEditor,
		})
		require.Equal(t, http.StatusOK, status, "body: %v", body)
		after, err := store.GetFileGrant(ctx, own.ID)
		require.NoError(t, err)
		require.Equal(t, model.GrantEditor, after.Level)

		status, body = doJSON(t, client, http.MethodDelete, url, nil)
		require.Equal(t, http.StatusOK, status, "body: %v", body)
		// The store reports a deleted row as an error, not a nil grant.
		gone, err := store.GetFileGrant(ctx, own.ID)
		require.True(t, err != nil || gone == nil, "the grant must be gone after a 200 DELETE")

		pa := providerA
		ownGroup, err := store.CreateGroup(ctx, &model.Group{Name: "diyetlif-ekip", ProviderID: &pa})
		require.NoError(t, err)
		ownGroupGrant, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
			StorageID: storageA.ID, PathPrefix: "Projeler", IsDir: true,
			GroupID: ownGroup.ID, Level: model.GrantViewer,
		})
		require.NoError(t, err)

		groupURL := srv.URL + "/api/admin/grants/" + itoa(ownGroupGrant.ID) + "?principal=group"
		status, body = doJSON(t, client, http.MethodPatch, groupURL, map[string]any{
			"level": model.GrantEditor,
		})
		require.Equal(t, http.StatusOK, status, "body: %v", body)
		status, body = doJSON(t, client, http.MethodDelete, groupURL, nil)
		require.Equal(t, http.StatusOK, status, "body: %v", body)
	})
}
