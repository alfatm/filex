-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00042_quota_limits.sql for the tri-state rule
-- (0 = inherit the instance default, -1 = unlimited, N = this user's limit).
ALTER TABLE users ADD COLUMN quota_files BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quota_upload_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN usage_files BIGINT NOT NULL DEFAULT 0;

-- staged_upload_id is the idempotency key for a RETRYABLE staged commit — see
-- the sqlite twin. VARCHAR rather than TEXT because MySQL cannot index a TEXT
-- column without a prefix length, and the value is a 36-character UUID.
CREATE TABLE IF NOT EXISTS upload_ledger (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id          BIGINT NOT NULL,
    bytes            BIGINT NOT NULL,
    staged_upload_id VARCHAR(64) NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_upload_ledger_user_time (user_id, created_at),
    UNIQUE KEY idx_upload_ledger_staged (staged_upload_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A correlated subquery over the target table itself is refused by MySQL
-- (error 1093), so the count comes through a join instead.
UPDATE users u
  LEFT JOIN (SELECT owner_id, COUNT(*) AS n FROM nodes WHERE type='file' GROUP BY owner_id) c
    ON c.owner_id = u.id
  SET u.usage_files = COALESCE(c.n, 0);

-- Preserve the PRE-migration meaning of quota_bytes = 0 ("unlimited", from
-- migration 00003) now that 0 means "inherit the instance default" — see the
-- sqlite twin, and docs/QUOTAS.md for the API-visible change.
UPDATE users SET quota_bytes = -1 WHERE quota_bytes = 0;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS upload_ledger;
ALTER TABLE users DROP COLUMN usage_files;
ALTER TABLE users DROP COLUMN quota_upload_bytes;
ALTER TABLE users DROP COLUMN quota_files;
-- +goose StatementEnd
