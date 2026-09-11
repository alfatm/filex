-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00042_quota_limits.sql for the tri-state rule
-- (0 = inherit the instance default, -1 = unlimited, N = this user's limit).
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_files BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_upload_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_files BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS upload_ledger (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL,
    bytes            BIGINT NOT NULL,
    staged_upload_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upload_ledger_user_time
    ON upload_ledger (user_id, created_at);

-- The idempotency key for a RETRYABLE staged commit — see the sqlite twin.
CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_ledger_staged
    ON upload_ledger (staged_upload_id);

UPDATE users SET usage_files =
    (SELECT COUNT(*) FROM nodes WHERE nodes.owner_id = users.id AND nodes.type = 'file');

-- Preserve the PRE-migration meaning of quota_bytes = 0 ("unlimited", from
-- migration 00003) now that 0 means "inherit the instance default" — see the
-- sqlite twin, and docs/QUOTAS.md for the API-visible change.
UPDATE users SET quota_bytes = -1 WHERE quota_bytes = 0;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS upload_ledger;
ALTER TABLE users DROP COLUMN IF EXISTS usage_files;
ALTER TABLE users DROP COLUMN IF EXISTS quota_upload_bytes;
ALTER TABLE users DROP COLUMN IF EXISTS quota_files;
-- +goose StatementEnd
