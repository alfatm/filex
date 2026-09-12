package realtime

import "testing"

// TestEmitToUserReachesEveryTab: the frame is addressed to a person, so all of
// that person's connections get it — and nobody else's do.
func TestEmitToUserReachesEveryTab(t *testing.T) {
	h := NewHub()
	tabA := NewClient(7, "Ada", 4)
	tabB := NewClient(7, "Ada", 4)
	other := NewClient(9, "Bo", 4)
	for _, c := range []*Client{tabA, tabB, other} {
		h.Attach(c)
	}

	h.EmitToUser(7, map[string]any{"type": "op", "op": map[string]any{"id": 3}})

	for _, c := range []*Client{tabA, tabB} {
		if got := drain(t, c)["type"]; got != "op" {
			t.Fatalf("client %d: got type %v, want op", c.ID, got)
		}
	}
	select {
	case frame := <-other.Send:
		t.Fatalf("frame leaked to another account: %s", frame)
	default:
	}
}

// TestEmitToUserNeedsNoRoom: the tray lives on pages that subscribe to no
// folder at all, which is the whole reason this addressing exists.
func TestEmitToUserNeedsNoRoom(t *testing.T) {
	h := NewHub()
	c := NewClient(7, "Ada", 4)
	h.Attach(c)

	h.EmitToUser(7, map[string]any{"type": "op"})

	if got := drain(t, c)["type"]; got != "op" {
		t.Fatalf("got %v, want op", got)
	}
}

// TestDetachStopsDelivery: a closed socket must not keep a client (and its
// buffered channel) alive in the registry.
func TestDetachStopsDelivery(t *testing.T) {
	h := NewHub()
	c := NewClient(7, "Ada", 4)
	h.Attach(c)
	h.Detach(c)

	h.EmitToUser(7, map[string]any{"type": "op"})

	select {
	case frame := <-c.Send:
		t.Fatalf("detached client still received %s", frame)
	default:
	}
	h.mu.Lock()
	_, still := h.users[7]
	h.mu.Unlock()
	if still {
		t.Fatal("empty user entry was left behind in the registry")
	}
}

// TestAttachSkipsAnonymous: UserID 0 is "nobody", and nothing is addressed to
// nobody — an entry under 0 would deliver one user's op frames to every
// anonymous connection on the server.
func TestAttachSkipsAnonymous(t *testing.T) {
	h := NewHub()
	anon := NewClient(0, "", 4)
	h.Attach(anon)

	h.EmitToUser(0, map[string]any{"type": "op"})

	select {
	case frame := <-anon.Send:
		t.Fatalf("anonymous client received %s", frame)
	default:
	}
}

// TestSlowReaderDoesNotBlock: a stalled tab drops its frame instead of wedging
// the emitter, same contract as every other broadcast here.
func TestSlowReaderDoesNotBlock(t *testing.T) {
	h := NewHub()
	stalled := NewClient(7, "Ada", 1)
	live := NewClient(7, "Ada", 4)
	h.Attach(stalled)
	h.Attach(live)
	stalled.Send <- []byte("{}") // fill the buffer

	h.EmitToUser(7, map[string]any{"type": "op"})

	if got := drain(t, live)["type"]; got != "op" {
		t.Fatalf("live tab got %v, want op", got)
	}
}
