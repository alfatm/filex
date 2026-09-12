-- +goose Up
-- +goose StatementBegin

-- The async copy/move/delete queue behind /api/files/ops. See the SQLite copy
-- of this migration for why the table only starts existing here.
CREATE TABLE IF NOT EXISTS pending_ops (
    id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind            VARCHAR(32) NOT NULL,
    storage_id      BIGINT NOT NULL,
    dest_storage_id BIGINT NOT NULL DEFAULT 0,
    user_id         BIGINT NULL DEFAULT NULL,
    sources_json    TEXT NOT NULL,
    dest            TEXT,
    total           INT NOT NULL DEFAULT 0,
    done            INT NOT NULL DEFAULT 0,
    failed          INT NOT NULL DEFAULT 0,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    error           TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      TIMESTAMP NULL DEFAULT NULL,
    finished_at     TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_pending_ops_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS pending_ops;
-- +goose StatementEnd
