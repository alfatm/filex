package notify_test

// The per-user opt-in matrix has been writable since migration 00007 — `PATCH
// /api/notifications/settings` stored `in_app_enabled` and a list of muted events — and NOTHING read
// it back. Every event was inserted and counted as unread whatever the user had asked for, so the
// switches in the settings modal would have been a picture of a feature.
//
// The mute silences the BELL, not the record: the same notifications rows are what the per-file
// activity feed reads, so dropping them would take a muted user's file history away from everybody.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/notify"
	"github.com/brf-tech/filex/backend/internal/testutil/dbtest"
)

func TestMutedEventLandsReadAndStaysInTheLog(t *testing.T) {
	ctx := context.Background()
	_, store := dbtest.NewTestDB(t)
	user, err := store.CreateUser(ctx, "muter@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)

	svc := notify.New(store, notify.Config{HTTPTimeout: time.Second})
	defer svc.Stop()

	require.NoError(t, store.UpsertNotificationSettings(ctx, &model.NotificationSettings{
		UserID:         user.ID,
		InAppEnabled:   true,
		MutedEventsRaw: json.RawMessage(`["share.created"]`),
	}))

	muted, err := svc.Send(ctx, notify.Event{
		Event: notify.EventShareCreated, Severity: notify.SeverityInfo, Title: "shared", UserID: &user.ID,
	})
	require.NoError(t, err)
	wanted, err := svc.Send(ctx, notify.Event{
		Event: notify.EventCommentAdded, Severity: notify.SeverityInfo, Title: "commented", UserID: &user.ID,
	})
	require.NoError(t, err)

	// The muted one is on record but does not demand attention; the other one does.
	unread, err := store.UnreadNotificationCount(ctx, &user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), unread)

	row, err := store.GetNotification(ctx, muted)
	require.NoError(t, err)
	require.NotNil(t, row.ReadAt, "a muted event is inserted already read, not skipped")
	row, err = store.GetNotification(ctx, wanted)
	require.NoError(t, err)
	require.Nil(t, row.ReadAt)
}

func TestInAppDisabledMutesEverythingForThatUserOnly(t *testing.T) {
	ctx := context.Background()
	_, store := dbtest.NewTestDB(t)
	quiet, err := store.CreateUser(ctx, "quiet@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	other, err := store.CreateUser(ctx, "other@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)

	svc := notify.New(store, notify.Config{HTTPTimeout: time.Second})
	defer svc.Stop()

	require.NoError(t, store.UpsertNotificationSettings(ctx, &model.NotificationSettings{
		UserID: quiet.ID, InAppEnabled: false, MutedEventsRaw: json.RawMessage(`[]`),
	}))

	for _, uid := range []int64{quiet.ID, other.ID} {
		id := uid
		_, err := svc.Send(ctx, notify.Event{
			Event: notify.EventFileUploaded, Severity: notify.SeverityInfo, Title: "uploaded", UserID: &id,
		})
		require.NoError(t, err)
	}

	quietUnread, err := store.UnreadNotificationCount(ctx, &quiet.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), quietUnread)
	// A user who never touched the settings gets everything: no row means "tell me".
	otherUnread, err := store.UnreadNotificationCount(ctx, &other.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), otherUnread)
}
