package ops

import "time"

// Live progress for the queue.
//
// The tray that draws a running copy used to learn about it by asking
// `GET /api/files/ops` every two seconds, from the moment the page loaded
// until it was closed — 43 200 requests a day per open tab, almost all of them
// answering "nothing is running". The queue knows perfectly well when
// something changes, so it says so instead.
//
// What lands in the browser is the SAME row the list endpoint returns, so the
// frontend has one shape to render and the poll stays a valid fallback for a
// client whose socket is down.

// Notifier pushes a frame to every connection one account has open.
// *realtime.Hub satisfies it; keeping it an interface here means the queue
// doesn't depend on the WebSocket layer (and stays testable with a fake).
type Notifier interface {
	EmitToUser(userID int64, payload any)
}

// SetNotifier wires the live channel. Call once at boot, before Run. Unwired
// (nil) disables emission — every caller then still has the poll.
func (s *Service) SetNotifier(n Notifier) { s.notifier = n }

// wireOp is the frame the browser receives. `type` discriminates it from the
// hub's change/presence frames on the same socket.
type wireOp struct {
	Type string `json:"type"` // always "op"
	Op   *Op    `json:"op"`
}

// progressInterval is the floor on the gap between two PROGRESS frames for one
// op. A 5 000-file batch would otherwise emit 5 000 frames — the same shape the
// hub's room coalescing exists for, at the same order of magnitude.
//
// Terminal frames (queued, running, finished, failed) ignore it: those are the
// ones a person is actually waiting on, and there are at most a handful per op.
const progressInterval = 250 * time.Millisecond

// emit sends op's current state to its submitter. Ops nobody asked for by hand
// (the retention sweep, a sync-driven op) carry no user and go nowhere.
//
// It takes a COPY of the row: the caller keeps mutating op.Done/op.Failed as
// the batch proceeds, and a frame marshalled later from a shared pointer would
// describe a different moment than the one it was sent for.
func (s *Service) emit(op *Op) {
	if s.notifier == nil || op == nil || op.UserID == nil {
		return
	}
	snapshot := *op
	s.notifier.EmitToUser(*op.UserID, wireOp{Type: "op", Op: &snapshot})
}

// emitProgress is emit, rate-limited per op. Use it inside the per-item loop;
// use emit directly for a state change.
func (s *Service) emitProgress(op *Op) {
	if s.notifier == nil || op == nil || op.UserID == nil {
		return
	}
	now := time.Now()
	s.progressMu.Lock()
	last, seen := s.lastProgress[op.ID]
	if seen && now.Sub(last) < progressInterval {
		s.progressMu.Unlock()
		return
	}
	if s.lastProgress == nil {
		s.lastProgress = make(map[int64]time.Time)
	}
	s.lastProgress[op.ID] = now
	s.progressMu.Unlock()
	s.emit(op)
}

// forgetProgress drops an op's rate-limit bookkeeping once it is finished, so
// the map tracks in-flight work rather than growing for the life of the
// process.
func (s *Service) forgetProgress(id int64) {
	s.progressMu.Lock()
	delete(s.lastProgress, id)
	s.progressMu.Unlock()
}
