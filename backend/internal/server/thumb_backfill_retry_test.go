package server

// What a backfill is allowed to re-run. `ready` is the state it never touches,
// which is right for a rendered picture and wrong for a row that only RECORDS
// a decision — StorageKey=original means "this file is cheap enough to serve
// raw", and the rule behind that moved when thumb gained a pixel limit.

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// thumbRows answers GetThumbnail from a map; ListNodesByParent is never called
// by shouldProcess and returns nothing.
type thumbRows map[int64]*model.Thumbnail

func (r thumbRows) ListNodesByParent(context.Context, int64, *int64) ([]*model.Node, error) {
	return nil, nil
}

func (r thumbRows) GetThumbnail(_ context.Context, nodeID int64) (*model.Thumbnail, error) {
	row, ok := r[nodeID]
	if !ok {
		return nil, nil
	}
	return row, nil
}

func TestBackfillShouldProcess(t *testing.T) {
	rows := thumbRows{
		1: {State: "ready", StorageKey: "1.jpg"},
		2: {State: "ready", StorageKey: thumb.OriginalKey},
		3: {State: "skipped"},
		4: {State: "failed"},
		5: {State: "pending"},
	}
	node := func(id int64) *model.Node { return &model.Node{ID: id} }

	for _, tc := range []struct {
		name string
		opts BackfillOptions
		want map[int64]bool
	}{
		{
			name: "default leaves every ready row alone",
			want: map[int64]bool{1: false, 2: false, 3: false, 4: false, 5: true, 99: true},
		},
		{
			name: "retry-original reaches the raw-tile rows and nothing else that is ready",
			opts: BackfillOptions{RetryOriginal: true},
			want: map[int64]bool{1: false, 2: true, 3: false, 4: false, 5: true},
		},
		{
			name: "retry-failed and retry-skipped stay independent of it",
			opts: BackfillOptions{RetryFailed: true, RetrySkipped: true},
			want: map[int64]bool{1: false, 2: false, 3: true, 4: true, 5: true},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := &backfillWalker{
				store:         rows,
				retryFailed:   tc.opts.RetryFailed,
				retrySkipped:  tc.opts.RetrySkipped,
				retryOriginal: tc.opts.RetryOriginal,
			}
			for id, want := range tc.want {
				require.Equal(t, want, w.shouldProcess(context.Background(), node(id)), "node %d", id)
			}
		})
	}
}
