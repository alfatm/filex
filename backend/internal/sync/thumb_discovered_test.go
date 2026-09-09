package sync_test

// Files that arrive ON a storage were catalogued and never thumbnailed.
//
// Every write through filex dispatches the pipeline from its handler. A file
// the walk discovers has no handler, so its tile stayed a placeholder until an
// operator ran `thumb backfill`. These tests run the REAL enqueue
// (queue.ThumbJob.Enqueue) against a REAL sqlite queue driver, the way server
// bootstrap wires it, so what they assert is the op that would be persisted.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/queue"
	filexsync "github.com/brf-tech/filex/backend/internal/sync"
	"github.com/brf-tech/filex/backend/internal/testutil/dbtest"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// countingGenerator stands in for thumb.Pipeline.GenerateThumb: it records
// which nodes the queue handed it and answers ErrSkipped, the pipeline's
// verdict for a file it will not render, which the job must treat as done.
type countingGenerator struct{ nodes []int64 }

func (g *countingGenerator) generate(_ context.Context, n *model.Node) error {
	g.nodes = append(g.nodes, n.ID)
	return thumb.ErrSkipped
}

// syncWithThumbs runs one sync pass with the thumbnail hook wired exactly as
// server bootstrap wires it.
func syncWithThumbs(t *testing.T, store db.Store, st *model.Storage, job *queue.ThumbJob, qd queue.Driver) {
	t.Helper()
	ctx := context.Background()
	w := filexsync.New(store)
	w.AttachThumbs(func(ctx context.Context, n *model.Node) { job.Enqueue(ctx, qd, n) })
	require.NoError(t, w.AddStorage(ctx, st))
	t.Cleanup(w.Stop)
	require.NoError(t, w.Trigger(ctx, st.ID))
	run, err := store.GetLastSyncRun(ctx, st.ID)
	require.NoError(t, err)
	require.Equal(t, "ok", run.Status, run.Error)
}

// pendingThumbs returns the node ids of every pending thumb op.
func pendingThumbs(t *testing.T, qd queue.Driver) []int64 {
	t.Helper()
	ops, _, err := qd.List(context.Background(), queue.StatusPending, 100000, 0)
	require.NoError(t, err)
	var ids []int64
	for _, op := range ops {
		if op.Type == queue.TypeThumb {
			ids = append(ids, payloadNodeID(t, op))
		}
	}
	return ids
}

func payloadNodeID(t *testing.T, op queue.Op) int64 {
	t.Helper()
	switch v := op.Payload["node_id"].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	}
	t.Fatalf("thumb op with an unusable node_id %T (%v)", op.Payload["node_id"], op.Payload["node_id"])
	return 0
}

// drainThumbs dequeues and runs every pending thumb op through the real
// handler, the way the worker pool would.
func drainThumbs(t *testing.T, qd queue.Driver, job *queue.ThumbJob) int {
	t.Helper()
	ctx := context.Background()
	n := 0
	for {
		op, err := qd.Dequeue(ctx, []string{queue.TypeThumb})
		if errors.Is(err, queue.ErrEmpty) {
			return n
		}
		require.NoError(t, err)
		require.NoError(t, job.Handle(ctx, op))
		require.NoError(t, qd.Ack(ctx, op.ID))
		n++
	}
}

// A file nobody wrote through filex is catalogued by the walk and handed to
// the pipeline through the queue; a directory is not.
func TestSyncAsksForAThumbnailOfAFileItDiscovered(t *testing.T) {
	ctx := context.Background()
	conn, store := dbtest.NewTestDB(t)
	st, _, root := localStorage(t, store)
	qd := avQueue(t, conn)

	require.NoError(t, os.WriteFile(filepath.Join(root, "manzara.jpg"), []byte("jpeg bytes"), 0o644))
	require.NoError(t, os.Mkdir(filepath.Join(root, "Klasor"), 0o755))

	gen := &countingGenerator{}
	job := queue.NewThumbJob(store, gen.generate)
	syncWithThumbs(t, store, st, job, qd)

	n, err := store.GetNodeByPath(ctx, st.ID, pathkey.Hash(st.ID, "/manzara.jpg"))
	require.NoError(t, err)
	require.NotNil(t, n, "precondition: the walk must catalogue the file")

	assert.Equal(t, []int64{n.ID}, pendingThumbs(t, qd), "the sync catalogued a file and asked for no thumbnail")

	require.Equal(t, 1, drainThumbs(t, qd, job))
	assert.Equal(t, []int64{n.ID}, gen.nodes, "the queued op must reach the pipeline")
}

// The walk sees the same objects on every pass, forever. Only the first pass,
// and a pass that sees the content drift, may ask for a render.
func TestSyncAsksOnceThenOnlyOnDrift(t *testing.T) {
	ctx := context.Background()
	conn, store := dbtest.NewTestDB(t)
	st, _, root := localStorage(t, store)
	qd := avQueue(t, conn)
	require.NoError(t, os.WriteFile(filepath.Join(root, "manzara.jpg"), []byte("jpeg bytes"), 0o644))

	gen := &countingGenerator{}
	job := queue.NewThumbJob(store, gen.generate)
	syncWithThumbs(t, store, st, job, qd)
	require.Equal(t, 1, drainThumbs(t, qd, job))

	waitPastSecondBoundary()
	syncWithThumbs(t, store, st, job, qd)
	syncWithThumbs(t, store, st, job, qd)
	assert.Empty(t, pendingThumbs(t, qd), "an unchanged file must not be re-enqueued on a later pass")

	waitPastSecondBoundary()
	require.NoError(t, os.WriteFile(filepath.Join(root, "manzara.jpg"), []byte("different jpeg bytes, longer"), 0o644))
	syncWithThumbs(t, store, st, job, qd)
	n, err := store.GetNodeByPath(ctx, st.ID, pathkey.Hash(st.ID, "/manzara.jpg"))
	require.NoError(t, err)
	assert.Equal(t, []int64{n.ID}, pendingThumbs(t, qd), "drifted content must be rendered again")
}

// A node deleted between enqueue and dequeue is done, not an error the queue
// would retry three times.
func TestThumbJobIgnoresANodeThatVanished(t *testing.T) {
	ctx := context.Background()
	_, store := dbtest.NewTestDB(t)
	gen := &countingGenerator{}
	job := queue.NewThumbJob(store, gen.generate)

	require.NoError(t, job.Handle(ctx, queue.Op{Type: queue.TypeThumb, Payload: map[string]any{"node_id": float64(424242)}}))
	assert.Empty(t, gen.nodes)
}

// A version snapshot is not a file anyone browses: it lives under `.versions/`,
// it is reachable only through the version history, and no listing shows it. The
// walk still catalogues it as an ordinary file, and the enqueue used to look at
// nothing but the node's type — so every snapshot of every image asked for a
// render, and got a cache file, for a tile that is never drawn. On a storage
// with any history that is thousands of ops per pass.
//
// The antivirus queue has refused these paths since it existed
// (AntivirusScanner.Eligible); this asserts the thumbnail queue now agrees.
func TestSyncAsksForNoThumbnailOfAVersionSnapshot(t *testing.T) {
	ctx := context.Background()
	conn, store := dbtest.NewTestDB(t)
	st, _, root := localStorage(t, store)
	qd := avQueue(t, conn)

	require.NoError(t, os.MkdirAll(filepath.Join(root, ".versions", "42"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".versions", "42", "1.jpg"), []byte("an older jpeg"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "manzara.jpg"), []byte("jpeg bytes"), 0o644))

	gen := &countingGenerator{}
	job := queue.NewThumbJob(store, gen.generate)
	syncWithThumbs(t, store, st, job, qd)

	snapshot, err := store.GetNodeByPath(ctx, st.ID, pathkey.Hash(st.ID, "/.versions/42/1.jpg"))
	require.NoError(t, err)
	require.NotNil(t, snapshot, "precondition: the walk catalogues the snapshot — that is why the queue has to refuse it")
	live, err := store.GetNodeByPath(ctx, st.ID, pathkey.Hash(st.ID, "/manzara.jpg"))
	require.NoError(t, err)

	assert.Equal(t, []int64{live.ID}, pendingThumbs(t, qd),
		"the person's file is queued and the snapshot beside it is not")
}
