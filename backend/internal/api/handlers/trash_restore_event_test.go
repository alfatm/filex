package handlers_test

// A node's activity feed is built from the events every write surface emits.
// A soft delete emitted `file.trashed`; the restore that undid it emitted
// nothing at all, so the panel showed a file that went to the trash and never
// came back — the one entry a user checks after an accidental delete.

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/notify"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/trash"
	"github.com/brf-tech/filex/backend/internal/writehook"
)

// waitForRestored returns the `file.restored` event, or fails: emission is
// fire-and-forget off the request path.
func waitForRestored(t *testing.T, s *eventSink) notify.Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		for _, e := range s.events {
			if e.Event == notify.EventFileRestored {
				s.mu.Unlock()
				return e
			}
		}
		s.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("no file.restored event emitted within 2s")
			return notify.Event{}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTrashRestoreEmitsFileRestored(t *testing.T) {
	ctx := context.Background()
	f := newRestoreFixture(t, false)

	sink := installEventSink(t)

	n := f.seedFile(t, "belgeler/plan.txt", "draft")
	out, err := trash.Put(ctx, f.drv, "belgeler/plan.txt")
	require.NoError(t, err)
	require.True(t, out.Trashed)
	trashClean := "/" + strings.Trim(out.Key, "/")
	require.NoError(t, f.store.SoftDeleteAndRetag(ctx, n.ID, trashClean,
		pathkey.Hash(f.st.ID, trashClean), n.Path))

	rec := f.postJSON(t, f.trashH.Restore, map[string]any{"node_id": n.ID})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	e := waitForRestored(t, sink)
	// The ORIGINAL path, not the `.filex-trash/…` key: the feed is read per
	// node path, so an event filed under the trash key reaches nobody.
	assert.Equal(t, "/belgeler/plan.txt", e.Body)
	require.NotNil(t, e.Node)
	assert.Equal(t, f.st.ID, e.Node.StorageID)
	assert.Equal(t, "/belgeler/plan.txt", e.Node.Path)
	assert.Equal(t, "plan.txt", e.Node.Name)
	assert.Equal(t, writehook.OriginManager, e.Meta["origin"])
}
