package ops_test

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	_ "github.com/brf-tech/filex/backend/internal/db/drivers/postgres"
	"github.com/brf-tech/filex/backend/internal/ops"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
)

func TestPostgresQueueRoundTrip(t *testing.T) {
	dsn := os.Getenv("FILEX_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("set FILEX_TEST_PG_DSN to run")
	}
	ctx := context.Background()
	drv := db.MustGet("postgres")
	conn, err := drv.Open(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	require.NoError(t, db.Migrate(ctx, drv, conn))
	_, err = conn.ExecContext(ctx, `TRUNCATE pending_ops`)
	require.NoError(t, err)

	svc := ops.New(conn, drv.Dialect(), func(int64) (storage.Driver, error) { return nil, nil })
	require.NoError(t, svc.Migrate(ctx))

	// Submit exercises the INSERT + RETURNING id path (pgx has no LastInsertId).
	op, err := svc.SubmitTo(ctx, ops.OpCopy, 1, 2, []string{"a.txt"}, "dst")
	require.NoError(t, err)
	require.NotZero(t, op.ID, "id must come back from RETURNING")
	require.Equal(t, int64(2), op.DestStorageID)

	got, err := svc.Get(ctx, op.ID)
	require.NoError(t, err)
	require.Equal(t, op.ID, got.ID)
	require.Equal(t, []string{"a.txt"}, got.Sources)

	// The exact query the admin tray polls, and the one that 500'd.
	running, err := svc.List(ctx, "running")
	require.NoError(t, err)
	require.Empty(t, running)

	all, err := svc.List(ctx, "")
	require.NoError(t, err)
	require.Len(t, all, 1)

	pending, err := svc.List(ctx, ops.StatusPending)
	require.NoError(t, err)
	require.Len(t, pending, 1)
}

// The worker's own statements — claimNext's UPDATE, the per-source progress
// UPDATE and the terminal one — carry placeholders too, so drive a real copy
// end to end rather than trusting that the read path proves them.
func TestPostgresWorkerRunsOp(t *testing.T) {
	dsn := os.Getenv("FILEX_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("set FILEX_TEST_PG_DSN to run")
	}
	ctx := context.Background()
	drv := db.MustGet("postgres")
	conn, err := drv.Open(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	require.NoError(t, db.Migrate(ctx, drv, conn))
	_, err = conn.ExecContext(ctx, `TRUNCATE pending_ops`)
	require.NoError(t, err)

	dir := t.TempDir()
	local := &local.Driver{}
	require.NoError(t, local.Init(ctx, map[string]any{"root": dir}))
	require.NoError(t, local.Write(ctx, "a.txt", strings.NewReader("hello"), 5))

	svc := ops.New(conn, drv.Dialect(), func(int64) (storage.Driver, error) { return local, nil })
	require.NoError(t, svc.Migrate(ctx))

	op, err := svc.Submit(ctx, ops.OpCopy, 1, []string{"a.txt"}, "copy.txt")
	require.NoError(t, err)

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go svc.Run(runCtx)

	var final *ops.Op
	require.Eventually(t, func() bool {
		got, err := svc.Get(ctx, op.ID)
		if err != nil || got.Status == ops.StatusPending || got.Status == ops.StatusRunning {
			return false
		}
		final = got
		return true
	}, 20*time.Second, 100*time.Millisecond, "op never reached a terminal status")

	require.Equal(t, ops.StatusOK, final.Status, "error: %s", final.Error)
	require.Equal(t, 1, final.Done)
	require.NotNil(t, final.FinishedAt)

	body, err := local.Read(ctx, "copy.txt")
	require.NoError(t, err)
	defer body.Close()
	out, err := io.ReadAll(body)
	require.NoError(t, err)
	require.Equal(t, "hello", string(out))
}
