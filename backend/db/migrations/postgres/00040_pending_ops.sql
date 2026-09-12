-- +goose Up
-- +goose StatementBegin

-- The async copy/move/delete queue behind /api/files/ops. See the SQLite copy
-- of this migration for why the table only starts existing here.
CREATE TABLE IF NOT EXISTS pending_ops (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL,
    storage_id      BIGINT NOT NULL,
    dest_storage_id BIGINT NOT NULL DEFAULT 0,
    user_id         BIGINT,
    sources_json    TEXT NOT NULL,
    dest            TEXT,
    total           INTEGER NOT NULL DEFAULT 0,
    done            INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_ops (status, created_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_pending_ops_status;
DROP TABLE IF EXISTS pending_ops;
-- +goose StatementEnd
