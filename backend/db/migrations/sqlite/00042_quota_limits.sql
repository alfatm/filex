-- +goose Up
-- +goose StatementBegin

-- Quota, part two: a file-COUNT ceiling and an upload-RATE ceiling next to the
-- byte ceiling migration 00003 added.
--
-- Every per-user limit column is a TRI-STATE override, which is what keeps the
-- rows already in the table valid:
--
--   0   inherit the instance default (settings `quota.default_*`)
--   -1  unlimited for this user, whatever the default says
--   N   this user's own limit
--
-- The default for every instance default is 0 = unlimited, so a fresh install
-- behaves exactly as it did before.
--
-- ⚠⚠ quota_bytes is the exception, and the reason for the backfill at the
-- bottom of this file: that column already EXISTED (migration 00003) and 0
-- there meant "unlimited", not "inherit". Adding the tri-state silently
-- redefined every row carrying 0 — an install that deliberately left every
-- account unlimited would be retroactively capped the first time an operator
-- set quota.default_bytes for NEW accounts. So the old meaning is written out
-- explicitly as -1 before anything can read the column the new way.
ALTER TABLE users ADD COLUMN quota_files BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quota_upload_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN usage_files BIGINT NOT NULL DEFAULT 0;

-- One row per COMPLETED upload, swept once it falls out of the rate window.
-- The window sum is what the rate limit is measured against, and the oldest row
-- inside the window is what Retry-After is derived from.
--
-- staged_upload_id is the IDEMPOTENCY key, and it is nullable because most
-- surfaces have no such id (a synchronous write has nothing to retry). A
-- staged upload whose transfer fails is retryable ON PURPOSE — the staging
-- directory is kept and `failed` is a committable state — so the commit path
-- runs a second, third and fourth time for ONE stored object. Without this
-- column each retry appended another row and three failed transfers of a 1 GB
-- file spent 4 GB of the allowance. The unique index is what makes the second
-- insert impossible rather than merely unlikely; several NULLs are allowed in
-- a UNIQUE index, so the surfaces that pass none are unaffected.
CREATE TABLE IF NOT EXISTS upload_ledger (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    bytes            INTEGER NOT NULL,
    staged_upload_id TEXT,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_upload_ledger_user_time
    ON upload_ledger (user_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_ledger_staged
    ON upload_ledger (staged_upload_id);

-- Backfill the file count the same way RecomputeUserUsage backfills bytes:
-- trashed rows INCLUDED, because a trashed file still occupies a slot for the
-- same reason its bytes still occupy the disk (docs/QUOTAS.md).
UPDATE users SET usage_files =
    (SELECT COUNT(*) FROM nodes WHERE nodes.owner_id = users.id AND nodes.type = 'file');

-- Preserve the PRE-migration meaning of quota_bytes = 0.
--
-- Before this migration 0 meant "unlimited" (migration 00003); from here on it
-- means "inherit quota.default_bytes". Rewriting those rows as -1 keeps them
-- unlimited whatever the instance default becomes, and — the part a backfill
-- of 0 could never give — makes "explicitly unlimited" distinguishable from
-- "never configured" for every account that existed before the tri-state.
--
-- ⚠ This changes the meaning of an API value, not just a column: see
-- docs/QUOTAS.md — POST/PATCH /api/admin/users/{id}/quota {"quota_bytes":0}
-- used to mean "unlimited" and now means "inherit". An API client that wants
-- unlimited must send -1.
UPDATE users SET quota_bytes = -1 WHERE quota_bytes = 0;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- ⚠ quota_bytes is deliberately NOT rewritten back to 0. Pre-00042 code reads
-- the column as `limit > 0 ? limit : unlimited`, so -1 and 0 behave
-- identically there — while an UPDATE back to 0 would erase a deliberate "-1 =
-- unlimited" an admin set AFTER the migration, which is real information.
DROP TABLE IF EXISTS upload_ledger;
ALTER TABLE users DROP COLUMN usage_files;
ALTER TABLE users DROP COLUMN quota_upload_bytes;
ALTER TABLE users DROP COLUMN quota_files;
-- +goose StatementEnd
