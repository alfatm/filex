-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00041_staged_uploads_target.sql for the rationale.
--
-- A prefix on storage_key: it is VARCHAR(2048) and utf8mb4, which is past the
-- 3072-byte key limit; the lookup is an exact match, so the prefix only narrows
-- and the engine compares the full value on the rows it selects.
CREATE INDEX idx_staged_uploads_target ON staged_uploads (storage_id, storage_key(255));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_staged_uploads_target ON staged_uploads;
-- +goose StatementEnd
