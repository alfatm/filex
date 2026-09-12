-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00041_staged_uploads_target.sql for the rationale.
CREATE INDEX IF NOT EXISTS idx_staged_uploads_target ON staged_uploads (storage_id, storage_key);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_staged_uploads_target;
-- +goose StatementEnd
