package sqlite_test

// Revocation as a fact of its own (migration 00045).
//
// Closing a link used to set expires_at = NOW and nothing else, so the row was
// indistinguishable from one whose TTL had simply run out: the end user saw the
// link vanish from their side while the admin Shares list kept an ordinary
// looking row nobody could explain. revoked_at records WHO-closed-it-by-hand,
// the active-only list drops it, and the admin search can actually find a row.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// seedShare returns a live link on a fresh node, owned by the given user.
func seedShare(t *testing.T, store db.Store, userID int64, name, token string) *model.Share {
	t.Helper()
	ctx := context.Background()
	stg, err := store.CreateStorage(ctx, &model.Storage{
		Name: "home-" + token, Driver: "local", MountPath: "/", SyncMode: model.SyncModePoll, SyncIntervalS: 900, Enabled: true,
	})
	require.NoError(t, err)
	n, err := store.CreateNode(ctx, &model.Node{
		StorageID: stg.ID, Name: name, Path: "/" + name, PathHash: "h-" + token, Type: model.NodeTypeFile,
		SyncState: model.SyncStateSynced,
	})
	require.NoError(t, err)
	exp := time.Now().Add(7 * 24 * time.Hour).UTC()
	sh, err := store.CreateShare(ctx, &model.Share{NodeID: n.ID, Token: token, ExpiresAt: &exp, CreatedBy: &userID})
	require.NoError(t, err)
	return sh
}

func TestRevokeShare_RecordsRevokedAtAndKillsTheLink(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	u, err := store.CreateUser(ctx, "ada@test.local", "h", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	sh := seedShare(t, store, u.ID, "plan.pdf", "tok-revoke-1")

	live, err := store.GetShareByID(ctx, sh.ID)
	require.NoError(t, err)
	require.Nil(t, live.RevokedAt, "a freshly minted link is not revoked")
	require.False(t, live.IsExpired(time.Now()))

	require.NoError(t, store.RevokeShare(ctx, sh.ID))

	dead, err := store.GetShareByID(ctx, sh.ID)
	require.NoError(t, err)
	require.NotNil(t, dead.RevokedAt, "revoking must record WHY the link died")
	require.NotNil(t, dead.ExpiresAt)
	assert.True(t, dead.IsExpired(time.Now()), "a revoked link must not open")

	// The row is the audit trail — revoking is not deleting.
	byToken, err := store.GetShareByToken(ctx, "tok-revoke-1")
	require.NoError(t, err)
	assert.NotNil(t, byToken.RevokedAt)

	// Revoking twice keeps the first revocation time: it is when the link
	// stopped working, and a second click must not rewrite that.
	first := *dead.RevokedAt
	require.NoError(t, store.RevokeShare(ctx, sh.ID))
	again, err := store.GetShareByID(ctx, sh.ID)
	require.NoError(t, err)
	assert.WithinDuration(t, first, *again.RevokedAt, time.Second)
}

func TestListAllShares_ActiveOnlyDropsRevoked(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	u, err := store.CreateUser(ctx, "ada@test.local", "h", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	kept := seedShare(t, store, u.ID, "kept.pdf", "tok-kept")
	closed := seedShare(t, store, u.ID, "closed.pdf", "tok-closed")
	require.NoError(t, store.RevokeShare(ctx, closed.ID))

	rows, total, err := store.ListAllShares(ctx, nil, "", true, 50, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(1), total, "the total must match the filtered set, not every row")
	require.Len(t, rows, 1)
	assert.Equal(t, kept.ID, rows[0].Share.ID)

	// Unfiltered, the admin still sees the closed link — and can tell it apart.
	all, total, err := store.ListAllShares(ctx, nil, "", false, 50, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
	require.Len(t, all, 2)
	revoked := map[int64]bool{}
	for _, row := range all {
		revoked[row.Share.ID] = row.Share.RevokedAt != nil
	}
	assert.True(t, revoked[closed.ID], "the admin row must carry revoked_at")
	assert.False(t, revoked[kept.ID])
}

func TestListAllShares_SearchesTokenPathAndCreator(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	ada, err := store.CreateUser(ctx, "ada@test.local", "h", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	bob, err := store.CreateUser(ctx, "bob@test.local", "h", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	adas := seedShare(t, store, ada.ID, "quarterly.pdf", "tok-aaa")
	bobs := seedShare(t, store, bob.ID, "holiday.jpg", "tok-bbb")

	for _, tc := range []struct {
		q    string
		want int64
	}{
		{"quarterly", adas.ID},
		{"tok-bbb", bobs.ID},
		{"ada@", adas.ID},
	} {
		rows, total, err := store.ListAllShares(ctx, nil, tc.q, false, 50, 0)
		require.NoError(t, err, tc.q)
		require.Equal(t, int64(1), total, "q=%q", tc.q)
		require.Len(t, rows, 1, "q=%q", tc.q)
		assert.Equal(t, tc.want, rows[0].Share.ID, "q=%q", tc.q)
	}

	// A search nobody matches is an empty page, not every row.
	_, total, err := store.ListAllShares(ctx, nil, "nothing-here", false, 50, 0)
	require.NoError(t, err)
	assert.Zero(t, total)
}
