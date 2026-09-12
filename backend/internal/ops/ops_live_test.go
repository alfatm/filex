package ops_test

// The queue's live channel: instead of every open tab asking "is anything
// running?" twice a second forever, the worker says what it is doing as it
// does it. These tests lock down WHAT is announced and to WHOM.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/ops"
)

// recorder stands in for *realtime.Hub.
type recorder struct {
	mu     sync.Mutex
	frames []recorded
}

type recorded struct {
	userID int64
	kind   string
	op     *ops.Op
}

func (r *recorder) EmitToUser(userID int64, payload any) {
	// The wire struct is unexported, and deliberately so — what a test should
	// depend on is the JSON the browser actually receives.
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	var frame struct {
		Type string  `json:"type"`
		Op   *ops.Op `json:"op"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		panic(err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames = append(r.frames, recorded{userID: userID, kind: frame.Type, op: frame.Op})
}

func (r *recorder) snapshot() []recorded {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]recorded, len(r.frames))
	copy(out, r.frames)
	return out
}

func (r *recorder) statuses() []string {
	out := []string{}
	for _, f := range r.snapshot() {
		if f.op != nil {
			out = append(out, f.op.Status)
		}
	}
	return out
}

// runOpAs is runOp with an authenticated submitter, which is what decides
// whether the op is announced at all.
func (f *opsFixture) runOpAs(t *testing.T, userID int64, kind string, sources []string, dest string) *ops.Op {
	t.Helper()
	ctx := auth.WithUser(context.Background(), &model.User{ID: userID, Email: "who@example.com"})
	op, err := f.svc.Submit(ctx, kind, f.st.ID, sources, dest)
	require.NoError(t, err)

	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go f.svc.Run(runCtx)

	deadline := time.Now().Add(3 * time.Second)
	for {
		cur, err := f.svc.Get(context.Background(), op.ID)
		require.NoError(t, err)
		if cur.Status == ops.StatusOK || cur.Status == ops.StatusFailed || cur.Status == ops.StatusPartial {
			f.svc.Stop()
			return cur
		}
		if time.Now().After(deadline) {
			f.svc.Stop()
			t.Fatalf("op %d did not finish; last status=%s", op.ID, cur.Status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestLive_AnnouncesSubmitAndTerminalState: the two frames the tray cannot do
// without — "this exists" and "this is how it ended".
func TestLive_AnnouncesSubmitAndTerminalState(t *testing.T) {
	f := newOpsFixture(t)
	rec := &recorder{}
	f.svc.SetNotifier(rec)
	f.seedDir(t, "dest")
	f.seedFile(t, "src.txt", "hello")

	f.runOpAs(t, 42, ops.OpMove, []string{"src.txt"}, "dest/")

	frames := rec.snapshot()
	require.NotEmpty(t, frames, "the queue announced nothing at all")
	for _, fr := range frames {
		require.Equal(t, int64(42), fr.userID, "a frame was addressed to the wrong account")
		require.NotNil(t, fr.op)
	}
	statuses := rec.statuses()
	require.Equal(t, ops.StatusPending, statuses[0], "first frame should be the submit")
	require.Equal(t, ops.StatusOK, statuses[len(statuses)-1], "last frame should be the terminal state")
	require.Contains(t, statuses, ops.StatusRunning, "the tray never learned the op had started")

	last := frames[len(frames)-1].op
	require.NotNil(t, last.FinishedAt, "terminal frame carries no finish time")
	require.Equal(t, 1, last.Done)
}

// TestLive_UnattributedOpIsNotAnnounced: work nobody asked for by hand (the
// retention sweep, a sync-driven op) has no submitter to tell.
func TestLive_UnattributedOpIsNotAnnounced(t *testing.T) {
	f := newOpsFixture(t)
	rec := &recorder{}
	f.svc.SetNotifier(rec)
	f.seedDir(t, "dest")
	f.seedFile(t, "src.txt", "hello")

	f.runOp(t, ops.OpMove, []string{"src.txt"}, "dest/") // no user in context

	require.Empty(t, rec.snapshot(), "an op with no submitter was announced to somebody")
}

// TestLive_FailureIsAnnounced: the failing path has its own DB write (fail())
// and never reaches the normal completion frame. A tray that hears nothing
// there shows a spinner forever.
//
// The failure used is an unresolvable storage, because a MISSING SOURCE is
// deliberately not one: runOne treats storage.ErrNotFound as already-done so a
// batch delete doesn't fail on an item that is already gone.
func TestLive_FailureIsAnnounced(t *testing.T) {
	f := newOpsFixture(t)
	rec := &recorder{}
	f.svc.SetNotifier(rec)

	ctx := auth.WithUser(context.Background(), &model.User{ID: 42, Email: "who@example.com"})
	op, err := f.svc.Submit(ctx, ops.OpMove, f.st.ID+999, []string{"whatever.txt"}, "dest/")
	require.NoError(t, err)

	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go f.svc.Run(runCtx)
	deadline := time.Now().Add(3 * time.Second)
	for {
		cur, err := f.svc.Get(context.Background(), op.ID)
		require.NoError(t, err)
		if cur.Status == ops.StatusFailed {
			f.svc.Stop()
			break
		}
		if time.Now().After(deadline) {
			f.svc.Stop()
			t.Fatalf("op did not fail; status=%s", cur.Status)
		}
		time.Sleep(10 * time.Millisecond)
	}

	statuses := rec.statuses()
	require.NotEmpty(t, statuses)
	require.Equal(t, ops.StatusFailed, statuses[len(statuses)-1],
		"a failed op's last frame said %q", statuses[len(statuses)-1])
	last := rec.snapshot()[len(statuses)-1].op
	require.NotEmpty(t, last.Error, "the failure frame carries no reason to show the user")
}

// TestLive_SnapshotsTheRow: frames are marshalled later, on another goroutine,
// while the worker keeps mutating the row it was handed. Sharing the pointer
// would make every frame describe the END of the batch rather than its own
// moment.
func TestLive_SnapshotsTheRow(t *testing.T) {
	f := newOpsFixture(t)
	rec := &recorder{}
	f.svc.SetNotifier(rec)
	f.seedDir(t, "dest")
	f.seedFile(t, "a.txt", "a")
	f.seedFile(t, "b.txt", "b")

	f.runOpAs(t, 42, ops.OpMove, []string{"a.txt", "b.txt"}, "dest/")

	frames := rec.snapshot()
	first, last := frames[0].op, frames[len(frames)-1].op
	require.NotSame(t, first, last, "every frame shares one row pointer")
	require.Equal(t, 0, first.Done, "the submit frame was overwritten by later progress")
	require.Equal(t, 2, last.Done)
}
