package perm_test

// Per-role operation permissions. The tests run against the REAL migrated
// schema (testutil.NewTestDB applies every migration, 00044 included) rather
// than a hand-built roles table, because half of what is being asserted here is
// that the migration and the compiled-in Defaults say the same thing. Two
// sources of truth that only ever meet in production is exactly the bug this
// feature would ship.

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/perm"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// Migration 00044 must write exactly what the code believes the defaults are.
func TestPerm_MigratedDefaultsMatchCatalogue(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()

	for role, want := range perm.Defaults {
		got, err := store.GetRolePermissions(ctx, role)
		require.NoErrorf(t, err, "role %s", role)
		assert.Equalf(t, want, got, "migration 00044 disagrees with perm.Defaults for %q", role)
	}
}

// Every legacy value is gone: a row still naming files.read/files.write would
// be a permission nothing enforces.
func TestPerm_NoLegacyVocabularySurvives(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	legacy := map[string]bool{"files.read": true, "files.write": true}

	for _, role := range []string{"admin", "user", "viewer"} {
		ops, err := store.GetRolePermissions(ctx, role)
		require.NoError(t, err)
		for _, op := range ops {
			if op == perm.Wildcard {
				continue
			}
			assert.Falsef(t, legacy[op], "role %s still carries legacy %q", role, op)
			assert.Truef(t, perm.Known(op), "role %s carries unknown op %q", role, op)
		}
	}
}

func TestPerm_AdminWildcardAllowsEverything(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)
	ctx := context.Background()

	for _, op := range perm.AllOps() {
		ok, err := svc.Allowed(ctx, "admin", op)
		require.NoError(t, err)
		assert.Truef(t, ok, "admin denied %s", op)
	}
	// …and it is reported EXPANDED, never as the raw "*".
	got, err := svc.Permissions(ctx, "admin")
	require.NoError(t, err)
	assert.Equal(t, perm.AllOps(), got)
	assert.NotContains(t, got, perm.Wildcard)
}

// The viewer's default set is exactly what the role could already do.
func TestPerm_ViewerDefaults(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)
	ctx := context.Background()

	for op, want := range map[string]bool{
		perm.OpDownload: true,
		perm.OpStar:     true,
		perm.OpUpload:   false,
		perm.OpDelete:   false,
		perm.OpShare:    false,
		perm.OpGrant:    false,
	} {
		ok, err := svc.Allowed(ctx, "viewer", op)
		require.NoError(t, err)
		assert.Equalf(t, want, ok, "viewer / %s", op)
	}
}

// A role nobody seeded is refused, and refused QUIETLY: a vanished role is a
// denial, not a 500 on every request the account makes.
func TestPerm_UnknownRoleDeniesWithoutError(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)

	ok, err := svc.Allowed(context.Background(), "auditor", perm.OpDownload)
	require.NoError(t, err)
	assert.False(t, ok)
}

// Set writes, and the cache does not keep answering the old question.
func TestPerm_SetInvalidatesCache(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)
	ctx := context.Background()

	// Warm the cache with the "yes" answer first — without the invalidation
	// this is the value that would still be served below.
	ok, err := svc.Allowed(ctx, "user", perm.OpDelete)
	require.NoError(t, err)
	require.True(t, ok)

	keep := []string{perm.OpDownload, perm.OpUpload}
	require.NoError(t, svc.Set(ctx, "user", keep))

	ok, err = svc.Allowed(ctx, "user", perm.OpDelete)
	require.NoError(t, err)
	assert.False(t, ok, "cache still serving the pre-Set answer")

	got, err := svc.Permissions(ctx, "user")
	require.NoError(t, err)
	// Catalogue order, not the order the caller happened to send.
	assert.Equal(t, []string{perm.OpUpload, perm.OpDownload}, got)
}

func TestPerm_SetRejectsUnknownOp(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)
	ctx := context.Background()

	err := svc.Set(ctx, "user", []string{perm.OpUpload, "files.teleport"})
	require.ErrorIs(t, err, perm.ErrUnknownOp)

	// …and nothing was written.
	got, err := svc.Permissions(ctx, "user")
	require.NoError(t, err)
	assert.Equal(t, perm.AllOps(), got)
}

func TestPerm_SetRefusesAdminAndUnknownRole(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)
	ctx := context.Background()

	require.ErrorIs(t, svc.Set(ctx, "admin", []string{perm.OpDownload}), perm.ErrNotEditable)
	require.ErrorIs(t, svc.Set(ctx, "auditor", []string{perm.OpDownload}), perm.ErrUnknownRole)

	// The admin row is untouched by the refused write.
	raw, err := store.GetRolePermissions(ctx, "admin")
	require.NoError(t, err)
	assert.Equal(t, []string{perm.Wildcard}, raw)
}

// An empty list is a legitimate answer ("this role may do nothing"), and must
// round-trip as one rather than as "no row" or as the defaults.
func TestPerm_SetEmptyIsHonoured(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	svc := perm.New(store)
	ctx := context.Background()

	require.NoError(t, svc.Set(ctx, "viewer", nil))
	got, err := svc.Permissions(ctx, "viewer")
	require.NoError(t, err)
	assert.Empty(t, got)

	ok, err := svc.Allowed(ctx, "viewer", perm.OpDownload)
	require.NoError(t, err)
	assert.False(t, ok)
}

// With no store at all (a hand-assembled Deps) the service answers from the
// compiled-in defaults instead of refusing everything.
func TestPerm_NoStoreFallsBackToDefaults(t *testing.T) {
	svc := perm.New(nil)
	ctx := context.Background()

	ok, err := svc.Allowed(ctx, "user", perm.OpUpload)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = svc.Allowed(ctx, "viewer", perm.OpUpload)
	require.NoError(t, err)
	assert.False(t, ok)
}

// The catalogue is what the admin screen renders and what PUT validates
// against; a duplicate or an unlabelled group would corrupt both.
func TestPerm_CatalogueIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	groups := map[string]bool{
		perm.GroupWrite: true, perm.GroupOrganise: true,
		perm.GroupRead: true, perm.GroupShare: true,
	}
	for _, o := range perm.Catalogue {
		assert.Falsef(t, seen[o.ID], "duplicate catalogue entry %q", o.ID)
		seen[o.ID] = true
		assert.Truef(t, groups[o.Group], "op %q has unknown group %q", o.ID, o.Group)
	}
	assert.Len(t, perm.AllOps(), len(perm.Catalogue))
}
