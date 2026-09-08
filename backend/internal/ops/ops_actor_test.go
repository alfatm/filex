package ops_test

// Who did it, for work the queue does.
//
// The worker runs on a server-lifetime context: by the time a queued move or
// delete executes, the request that asked for it is long over, so every file
// event it emitted named no actor at all. That was tolerable while the queue
// only served copy; it stopped being tolerable when a file's own activity feed
// started reading those events and had to say "somebody moved it to Docs".
//
// The submitter's id is written on the row at submit time, where there still is
// a request, and put back on the context the steps run under.

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/ops"
)

// finish runs the worker until the op leaves the queue. The fixture's own runOp
// submits for you; this one takes an op already submitted with a chosen context.
func (f *opsFixture) finish(t *testing.T, op *ops.Op) {
	t.Helper()
	ctx := context.Background()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go f.svc.Run(runCtx)
	defer f.svc.Stop()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		cur, err := f.svc.Get(ctx, op.ID)
		require.NoError(t, err)
		if cur.Status != ops.StatusPending && cur.Status != ops.StatusRunning {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("op %d did not finish", op.ID)
}

// actorSpy is a DBSync that records the user each callback saw on its context.
type actorSpy struct {
	mu    sync.Mutex
	seen  []*model.User
	calls int
}

func (a *actorSpy) note(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	a.seen = append(a.seen, auth.UserFrom(ctx))
}

func (a *actorSpy) SyncMove(ctx context.Context, _ int64, _, _ string)       { a.note(ctx) }
func (a *actorSpy) SyncSoftDelete(ctx context.Context, _ int64, _, _ string) { a.note(ctx) }
func (a *actorSpy) SyncHardDelete(ctx context.Context, _ int64, _ string)    { a.note(ctx) }
func (a *actorSpy) SyncCopy(ctx context.Context, _ int64, _, _ string)       { a.note(ctx) }
func (a *actorSpy) SyncCopyAcross(ctx context.Context, _ int64, _ string, _ int64, _ string) {
	a.note(ctx)
}

func (a *actorSpy) last() *model.User {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.seen) == 0 {
		return nil
	}
	return a.seen[len(a.seen)-1]
}

func TestOpsWorker_CarriesTheSubmitterOntoTheWorkersContext(t *testing.T) {
	f := newOpsFixture(t)
	spy := &actorSpy{}
	f.svc.SetSync(spy)

	ctx := context.Background()
	user, err := f.store.CreateUser(ctx, "ayse@filex.test", "x", "user", "tr", "UTC")
	require.NoError(t, err)

	f.seedDir(t, "Docs")
	f.seedFile(t, "tasi.txt", "yuk")

	// Submitted the way a handler submits it: the user is on the request context.
	op, err := f.svc.SubmitTo(auth.WithUser(ctx, user), ops.OpMove, f.st.ID, f.st.ID, []string{"tasi.txt"}, "Docs/")
	require.NoError(t, err)
	f.finish(t, op)

	require.Equal(t, 1, spy.calls, "the move must have run")
	seen := spy.last()
	require.NotNil(t, seen, "the worker's context must carry the account that queued the op")
	require.Equal(t, user.ID, seen.ID)
	require.Equal(t, "ayse@filex.test", seen.Email)
}

func TestOpsWorker_AnOpNobodySubmittedStaysUnattributed(t *testing.T) {
	f := newOpsFixture(t)
	spy := &actorSpy{}
	f.svc.SetSync(spy)

	f.seedDir(t, "Docs")
	f.seedFile(t, "tasi.txt", "yuk")

	// No user on the context — a sweep, a sync-driven op, an internal retry.
	op, err := f.svc.SubmitTo(context.Background(), ops.OpMove, f.st.ID, f.st.ID, []string{"tasi.txt"}, "Docs/")
	require.NoError(t, err)
	f.finish(t, op)

	require.Equal(t, 1, spy.calls)
	require.Nil(t, spy.last(), "inventing an actor would be worse than having none")
}
