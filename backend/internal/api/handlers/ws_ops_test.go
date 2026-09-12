package handlers_test

// The queue's live channel, end to end over a real socket.
//
// The unit tests either side of this one cover the hub's addressing and the
// worker's emission; what only a real upgrade can show is that a connection is
// registered for its user WITHOUT subscribing to a folder — the tray sits at
// the layout level, on pages that join no room, and that is precisely where
// the old code polled forever instead.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
)

func TestWSDeliversOpFrameWithoutSubscribing(t *testing.T) {
	user := &model.User{ID: 42, Email: "ada@example.com"}
	url, hub, _ := newWSFixture(t, user)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: http.DefaultClient})
	require.NoError(t, err)
	defer conn.CloseNow()

	// No "subscribe" is sent on purpose.
	//
	// Attach happens during the upgrade, but Dial returns as soon as the HTTP
	// response is written — the handler may not have reached it yet, and a
	// frame emitted into that gap is dropped rather than queued. So a ticker
	// re-emits from a goroutine while the test does ONE long read: a read whose
	// context expires takes the whole connection down with it (coder/websocket
	// closes on read-context cancellation), which is what made the retry-loop
	// version of this test flake under load.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			hub.EmitToUser(user.ID, map[string]any{
				"type": "op",
				"op":   map[string]any{"id": 7, "kind": "copy", "status": "running", "total": 3, "done": 1},
			})
			select {
			case <-stop:
				return
			case <-tick.C:
			}
		}
	}()

	readCtx, readCancel := context.WithTimeout(ctx, 4*time.Second)
	defer readCancel()
	_, data, err := conn.Read(readCtx)
	require.NoError(t, err, "no op frame arrived over the socket")

	var frame map[string]any
	require.NoError(t, json.Unmarshal(data, &frame))
	require.Equal(t, "op", frame["type"])
	op, ok := frame["op"].(map[string]any)
	require.True(t, ok, "frame carried no op: %s", data)
	require.EqualValues(t, 7, op["id"])
	require.Equal(t, "running", op["status"])
}

func TestWSOpFrameStaysWithItsOwner(t *testing.T) {
	user := &model.User{ID: 42, Email: "ada@example.com"}
	url, hub, _ := newWSFixture(t, user)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: http.DefaultClient})
	require.NoError(t, err)
	defer conn.CloseNow()

	// Someone else's op. Nothing about it may reach this socket — an op frame
	// names what a person is copying and where they are putting it.
	for i := 0; i < 5; i++ {
		hub.EmitToUser(99, map[string]any{
			"type": "op",
			"op":   map[string]any{"id": 8, "dest": "/secret/quarterly-layoffs"},
		})
		time.Sleep(20 * time.Millisecond)
	}

	readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer readCancel()
	_, data, rerr := conn.Read(readCtx)
	require.Error(t, rerr, "another account's op frame arrived: %s", data)
}
