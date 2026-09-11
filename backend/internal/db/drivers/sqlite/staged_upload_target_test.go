package sqlite_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// ActiveStagedUploadForTarget is the active-upload lock: a `staging` row counts
// only while recently touched, a `committing` row at any age, and the caller's
// own row never.
func TestStore_ActiveStagedUploadForTarget(t *testing.T) {
	sqlDB, store := testutil.NewTestDB(t)
	ctx := context.Background()

	cfg, _ := json.Marshal(map[string]any{"root": "/tmp"})
	st, err := store.CreateStorage(ctx, &model.Storage{Name: "main", Driver: "local", MountPath: "/", ConfigJSON: cfg, Enabled: true})
	require.NoError(t, err)

	mk := func(id, key string) {
		require.NoError(t, store.CreateStagedUpload(ctx, &model.StagedUpload{
			ID: id, StorageID: st.ID, StorageKey: key, TotalSize: 10, ChunkSize: 10,
			State: model.StagedUploadStaging, ExpiresAt: time.Now().Add(time.Hour),
		}))
	}
	since := time.Now().Add(-30 * time.Second)

	got, err := store.ActiveStagedUploadForTarget(ctx, st.ID, "a.txt", since, "")
	require.NoError(t, err)
	assert.Nil(t, got, "no rows at all")

	mk("fresh", "a.txt")
	mk("elsewhere", "b.txt")

	got, err = store.ActiveStagedUploadForTarget(ctx, st.ID, "a.txt", since, "")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "fresh", got.ID)

	got, err = store.ActiveStagedUploadForTarget(ctx, st.ID, "a.txt", since, "fresh")
	require.NoError(t, err)
	assert.Nil(t, got, "the caller's own row is not a lock")

	got, err = store.ActiveStagedUploadForTarget(ctx, st.ID+1, "a.txt", since, "")
	require.NoError(t, err)
	assert.Nil(t, got, "same key on another storage")

	// Stalled: last chunk landed two minutes ago. CURRENT_TIMESTAMP is UTC
	// text and so is datetime('now', …), whatever TZ the process runs in.
	_, err = sqlDB.Exec(`UPDATE staged_uploads SET updated_at=datetime('now','-2 minutes') WHERE id='fresh'`)
	require.NoError(t, err)
	got, err = store.ActiveStagedUploadForTarget(ctx, st.ID, "a.txt", since, "")
	require.NoError(t, err)
	assert.Nil(t, got, "a stalled staging row does not lock")

	// Committing locks regardless of age; the state update itself bumps
	// updated_at, so age it again afterwards to prove the point.
	require.NoError(t, store.UpdateStagedUploadState(ctx, "fresh", model.StagedUploadCommitting, ""))
	_, err = sqlDB.Exec(`UPDATE staged_uploads SET updated_at=datetime('now','-2 hours') WHERE id='fresh'`)
	require.NoError(t, err)
	got, err = store.ActiveStagedUploadForTarget(ctx, st.ID, "a.txt", since, "")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, model.StagedUploadCommitting, got.State)

	require.NoError(t, store.UpdateStagedUploadState(ctx, "fresh", model.StagedUploadFailed, "boom"))
	got, err = store.ActiveStagedUploadForTarget(ctx, st.ID, "a.txt", since, "")
	require.NoError(t, err)
	assert.Nil(t, got, "a failed row is not moving bytes")
}

// ClaimStagedUploadCommit is the same lock, taken rather than asked about: the
// check and the state change are one statement, so of two commits racing on one
// file exactly one proceeds. Asking first and writing afterwards used to leave a
// gap the length of a snapshot, and both sides of that gap published a node.
func TestStore_ClaimStagedUploadCommit(t *testing.T) {
	sqlDB, store := testutil.NewTestDB(t)
	ctx := context.Background()

	cfg, _ := json.Marshal(map[string]any{"root": "/tmp"})
	st, err := store.CreateStorage(ctx, &model.Storage{Name: "main", Driver: "local", MountPath: "/", ConfigJSON: cfg, Enabled: true})
	require.NoError(t, err)

	mk := func(id, key string) {
		require.NoError(t, store.CreateStagedUpload(ctx, &model.StagedUpload{
			ID: id, StorageID: st.ID, StorageKey: key, TotalSize: 10, ChunkSize: 10,
			State: model.StagedUploadStaging, ExpiresAt: time.Now().Add(time.Hour),
		}))
	}
	window := func() time.Time { return time.Now().Add(-30 * time.Second) }

	mk("one", "a.txt")
	mk("two", "a.txt")
	mk("other", "b.txt")
	// Both went quiet long ago — the case that used to slip through, because
	// neither was fresh enough to be anyone's lock.
	_, err = sqlDB.Exec(`UPDATE staged_uploads SET updated_at=datetime('now','-2 minutes')`)
	require.NoError(t, err)

	ok, err := store.ClaimStagedUploadCommit(ctx, "one", window())
	require.NoError(t, err)
	assert.True(t, ok, "an unheld target is taken")

	ok, err = store.ClaimStagedUploadCommit(ctx, "two", window())
	require.NoError(t, err)
	assert.False(t, ok, "the target is held by a committing row, at any age")

	row, err := store.GetStagedUpload(ctx, "two")
	require.NoError(t, err)
	assert.Equal(t, model.StagedUploadStaging, row.State, "a refused claim changes nothing")

	ok, err = store.ClaimStagedUploadCommit(ctx, "one", window())
	require.NoError(t, err)
	assert.False(t, ok, "a row that is already committing cannot claim again")

	ok, err = store.ClaimStagedUploadCommit(ctx, "other", window())
	require.NoError(t, err)
	assert.True(t, ok, "another target is another lock")

	// A failed transfer keeps its staging directory so it can be retried, so it
	// has to be claimable again once the target is free.
	require.NoError(t, store.UpdateStagedUploadState(ctx, "one", model.StagedUploadFailed, "boom"))
	ok, err = store.ClaimStagedUploadCommit(ctx, "one", window())
	require.NoError(t, err)
	assert.True(t, ok)
	row, err = store.GetStagedUpload(ctx, "one")
	require.NoError(t, err)
	assert.Equal(t, model.StagedUploadCommitting, row.State)
	assert.Empty(t, row.Error, "the retry clears the message the failure left")
}
