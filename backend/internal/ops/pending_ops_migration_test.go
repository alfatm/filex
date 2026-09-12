package ops_test

import (
	"context"
	"testing"

	"github.com/pressly/goose/v3"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	_ "github.com/brf-tech/filex/backend/internal/db/drivers/sqlite"
)

// TestLegacyPendingOpsSurvivesMigration reproduces an installation that ran
// the hand-rolled DDL: the table already exists, with the two ALTERed columns
// and a live row. 00040 must be a no-op there, not a failure or a data loss.
func TestLegacyPendingOpsSurvivesMigration(t *testing.T) {
	ctx := context.Background()
	drv := db.MustGet("sqlite")
	conn, err := drv.Open(ctx, "file:legacy_ops_check?mode=memory&cache=shared")
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })

	// Migrate to just before 00040, then plant the old hand-rolled table.
	goose.SetBaseFS(drv.MigrationsFS())
	defer goose.SetBaseFS(nil)
	require.NoError(t, goose.SetDialect(drv.Dialect()))
	require.NoError(t, goose.UpToContext(ctx, conn, ".", 39))

	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS pending_ops (
			id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
			storage_id INTEGER NOT NULL, sources_json TEXT NOT NULL, dest TEXT,
			total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
			failed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
			error TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			started_at DATETIME, finished_at DATETIME)`,
		`CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_ops(status, created_at)`,
		`ALTER TABLE pending_ops ADD COLUMN dest_storage_id INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pending_ops ADD COLUMN user_id INTEGER`,
		`INSERT INTO pending_ops (kind, storage_id, sources_json, dest, total, status)
		 VALUES ('move', 7, '["a.txt"]', 'dst', 1, 'running')`,
	} {
		_, err := conn.ExecContext(ctx, stmt)
		require.NoError(t, err, stmt)
	}

	require.NoError(t, goose.UpContext(ctx, conn, "."), "00040 on a legacy install")

	var n int
	require.NoError(t, conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pending_ops WHERE kind='move' AND storage_id=7`).Scan(&n))
	require.Equal(t, 1, n, "pre-existing in-flight op must survive")
}
