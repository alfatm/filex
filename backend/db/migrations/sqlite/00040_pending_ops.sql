-- +goose Up
-- +goose StatementBegin

-- The async copy/move/delete queue behind /api/files/ops.
--
-- This table predates the migration: ops.Service used to CREATE it by hand at
-- boot from SQLite-only DDL, so it existed on SQLite and nowhere else — on
-- Postgres and MySQL the CREATE failed, the failure was only logged, and the
-- whole queue answered 500. Owning the schema here is what makes it portable.
--
-- On an installation that already ran the hand-rolled DDL the CREATE is a
-- no-op: the shape below is that DDL plus the two columns it went on to ALTER
-- in (dest_storage_id, user_id).
CREATE TABLE IF NOT EXISTS pending_ops (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    storage_id      INTEGER NOT NULL,
    dest_storage_id INTEGER NOT NULL DEFAULT 0,
    user_id         INTEGER,
    sources_json    TEXT NOT NULL,
    dest            TEXT,
    total           INTEGER NOT NULL DEFAULT 0,
    done            INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      DATETIME,
    finished_at     DATETIME
);

-- Both readers filter or order on status: the worker's claimNext takes the
-- oldest `pending`, the SPA's tray polls `status=running` every 2s.
CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_ops (status, created_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_pending_ops_status;
DROP TABLE IF EXISTS pending_ops;
-- +goose StatementEnd
