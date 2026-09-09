package queue

import (
	"context"
	"errors"
	"log/slog"
	"strconv"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// ThumbJob owns the TypeThumb op (declared with the other op types in
// driver.go; reserved since the queue existed, handled by nothing until now).
//
// Every write THROUGH filex dispatches the thumbnail pipeline itself, in a
// goroutine, from the handler that wrote the file. A file the sync walk
// DISCOVERS — already on the disk when the storage was added, or dropped there
// by another process — has no handler, and until this job it had no thumbnail
// either until an operator ran `thumb backfill`.
//
// A queue op rather than the handlers' goroutine, because the walk finds files
// by the thousand: one goroutine per file is an ffmpeg storm, the pool is a
// bounded one. Best-effort by contract, like the antivirus and content-index
// jobs: an enqueue failure is logged, never returned.
type ThumbJob struct {
	store NodeGetter
	// generate is thumb.Pipeline.GenerateThumb. Its ErrSkipped is a verdict,
	// not a failure — the pipeline has already recorded why.
	generate func(ctx context.Context, n *model.Node) error
}

// NewThumbJob wires the job over the pipeline's generate function.
func NewThumbJob(store NodeGetter, generate func(ctx context.Context, n *model.Node) error) *ThumbJob {
	return &ThumbJob{store: store, generate: generate}
}

// Enqueue schedules a thumbnail for a file the walk catalogued or saw drift.
// One pending op per node: a burst of drift on the same file costs one
// render, and a re-run of the walk cannot queue a second copy of a pending
// one. Discovered priority, so the queue serves a person's upload first.
func (j *ThumbJob) Enqueue(ctx context.Context, drv Driver, n *model.Node) {
	if j == nil || drv == nil || n == nil || n.Type != model.NodeTypeFile || n.DeletedAt != nil {
		return
	}
	if _, err := drv.Enqueue(ctx, Op{
		Type:     TypeThumb,
		Payload:  map[string]any{"node_id": n.ID},
		Priority: PriorityDiscovered,
		DedupKey: TypeThumb + ":" + strconv.FormatInt(n.ID, 10),
	}); err != nil && !errors.Is(err, ErrDuplicate) {
		slog.Warn("thumb: enqueue failed", slog.Int64("node", n.ID), slog.String("err", err.Error()))
	}
}

// Handle renders one thumb op. A node that vanished before the worker got to
// it, and a file the pipeline declines, both resolve as done: there is nothing
// a retry would change. A generation error is returned so the queue's retry
// budget applies — the pipeline has already recorded the row as failed.
func (j *ThumbJob) Handle(ctx context.Context, op Op) error {
	nodeID := payloadInt64(op.Payload, "node_id")
	if nodeID == 0 {
		return nil
	}
	n, err := j.store.GetNode(ctx, nodeID)
	if err != nil || n == nil || n.DeletedAt != nil {
		return nil
	}
	if err := j.generate(ctx, n); err != nil && !errors.Is(err, thumb.ErrSkipped) {
		return err
	}
	return nil
}
