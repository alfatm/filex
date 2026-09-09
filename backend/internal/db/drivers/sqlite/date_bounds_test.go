package sqlite_test

// Dates compared as TEXT, which is the only way SQLite can compare them.
//
// Every column filled by CURRENT_TIMESTAMP holds `YYYY-MM-DD HH:MM:SS` in UTC.
// A time.Time bound through `?` goes out in Go's own layout with a zone offset
// on the end, so the comparison loses at the separator before the offset is
// even reached, and the offset then shifts the visible wall clock on top of
// that. The sync pass and the session sweeper were both fixed for this before;
// these are the queries that still bound a caller's clock straight into it.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// ⚠ This one destroys files. trash.Service builds its cutoff with time.Now(),
// which carries the host's zone: east of UTC the wall clock of "an hour ago"
// reads LATER than the UTC text of "deleted a second ago", so the retention
// sweep purged what it was meant to keep.
func TestListTrashedExpired_ReadsTheCutoffAsAnInstant(t *testing.T) {
	ctx, store, _, mk := facetFixture(t)
	n := mk("yeni.md", model.NodeTypeFile)
	require.NoError(t, store.SoftDeleteNode(ctx, n.ID))

	east := time.FixedZone("+03", 3*60*60)
	kept, err := store.ListTrashedExpired(ctx, time.Now().Add(-time.Hour).In(east), 50)
	require.NoError(t, err)
	assert.Empty(t, names(kept),
		"deleted a moment ago, so an hour of retention keeps it whatever zone the sweeper's clock is in")

	// A cutoff that really is in the future still selects it — otherwise this
	// would pass on a query that had simply stopped matching anything.
	swept, err := store.ListTrashedExpired(ctx, time.Now().Add(time.Hour).In(east), 50)
	require.NoError(t, err)
	assert.Equal(t, []string{"yeni.md"}, names(swept))
}

// The audit page's date range arrives parsed from RFC3339 on the query string,
// so it carries whatever offset the operator's browser sent.
func TestListAuditFiltered_ReadsTheRangeAsInstants(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "denetci@filex.test", "x", model.RoleAdmin, "en", "UTC")
	require.NoError(t, err)
	require.NoError(t, store.InsertAuditEntry(ctx, &model.AuditEntry{
		UserID: &user.ID, Action: "file.delete", TargetType: "node", TargetID: "1",
	}))

	east := time.FixedZone("+03", 3*60*60)
	from := time.Now().Add(-time.Hour).In(east)
	to := time.Now().Add(time.Hour).In(east)

	entries, total, err := store.ListAuditFiltered(ctx, nil, "", &from, &to, 50, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total, "an entry written a moment ago is inside a window that opened an hour ago")
	require.Len(t, entries, 1)
	assert.Equal(t, "file.delete", entries[0].Entry.Action)

	// A window that closed before the entry was written still excludes it.
	closed := time.Now().Add(-time.Hour).In(east)
	entries, total, err = store.ListAuditFiltered(ctx, nil, "", nil, &closed, 50, 0)
	require.NoError(t, err)
	assert.Zero(t, total)
	assert.Empty(t, entries)
}
