package sqlite_test

// Everything with an expiry in the SQLite driver used to compare `expires_at > CURRENT_TIMESTAMP`.
// SQLite compares those as TEXT, the driver writes a Go time WITH its zone offset, and
// CURRENT_TIMESTAMP is UTC — so the two strings are not on the same clock. On a host at UTC+3 a
// session that had expired three hours ago still authenticated, the sweeper would not collect it,
// and an expired public link still opened; west of UTC the error ran the other way and killed live
// ones early. Every cutoff is a bound parameter now, encoded exactly like the value it is compared
// against.
//
// The test runs in a fixed non-UTC zone, which is the only condition under which the old code was
// wrong — under TZ=UTC it passed and shipped.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/testutil/dbtest"
)

func TestExpiryIsHonouredOutsideUTC(t *testing.T) {
	east := time.FixedZone("UTC+3", 3*60*60)
	west := time.FixedZone("UTC-5", -5*60*60)
	ctx := context.Background()
	_, store := dbtest.NewTestDB(t)

	user, err := store.CreateUser(ctx, "zone@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)

	// Expired an hour ago, recorded by a server running east of UTC.
	_, err = store.CreateSession(ctx, user.ID, "stale", time.Now().In(east).Add(-time.Hour), "", "")
	require.NoError(t, err)
	// Still live for another hour, recorded west of UTC.
	_, err = store.CreateSession(ctx, user.ID, "live", time.Now().In(west).Add(time.Hour), "", "")
	require.NoError(t, err)

	_, err = store.GetSessionByToken(ctx, "stale")
	require.Error(t, err, "an expired session must not authenticate anything")
	got, err := store.GetSessionByToken(ctx, "live")
	require.NoError(t, err)
	require.Equal(t, user.ID, got.UserID)

	live, err := store.ListSessionsForUser(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, live, 1, "only the unexpired session is listed")

	count, err := store.CountActiveSessions(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	require.NoError(t, store.DeleteExpiredSessions(ctx))
	remaining, err := store.CountActiveSessions(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), remaining)
	_, err = store.GetSessionByToken(ctx, "live")
	require.NoError(t, err, "the sweeper takes the expired one and nothing else")
}
