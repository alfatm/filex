package realtime

import "encoding/json"

// Per-user addressing — the second way the hub reaches a browser.
//
// Rooms answer "who is looking at this folder"; this answers "who is this
// person, wherever they are". The queue's progress is the case it exists for:
// a copy belongs to whoever submitted it, not to the folder it happens to be
// writing into, and the tray that draws it lives at the layout level on every
// page — including the pages that are in no room at all.
//
// Attach/Detach are therefore about the CONNECTION, not about a room: a client
// is attached the moment it authenticates and stays attached until the socket
// closes, whether or not it ever subscribes to anything.

// Attach registers a live connection under its user id. Anonymous clients
// (UserID 0) are skipped — nothing is addressed to nobody.
func (h *Hub) Attach(c *Client) {
	if c == nil || c.UserID == 0 {
		return
	}
	h.mu.Lock()
	set := h.users[c.UserID]
	if set == nil {
		set = make(map[*Client]struct{})
		h.users[c.UserID] = set
	}
	set[c] = struct{}{}
	h.mu.Unlock()
}

// Detach removes a connection from the per-user registry. Call it on socket
// close, beside Unsubscribe.
func (h *Hub) Detach(c *Client) {
	if c == nil || c.UserID == 0 {
		return
	}
	h.mu.Lock()
	if set := h.users[c.UserID]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.users, c.UserID)
		}
	}
	h.mu.Unlock()
}

// EmitToUser pushes one frame to every connection this user has open — their
// other tabs included, which is how a copy started in one tab draws its
// progress in the others.
//
// payload is marshalled once for all of them and must already carry its own
// `type` discriminator, exactly as the change/presence frames do. A user with
// nothing open is a no-op, and a stalled reader drops the frame rather than
// holding up the rest (same non-blocking send as every other broadcast here).
func (h *Hub) EmitToUser(userID int64, payload any) {
	if userID == 0 {
		return
	}
	frame, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.users[userID] {
		trySend(c, frame)
	}
}
