-- +goose Up
-- +goose StatementBegin

-- The active-upload lock (handlers/upload_staged.go, ActiveStagedUploadForTarget)
-- asks "is another session moving bytes to this key right now" on every begin,
-- commit and multipart upload. Without an index on the target that question is
-- a scan of every open session per upload.
CREATE INDEX IF NOT EXISTS idx_staged_uploads_target ON staged_uploads (storage_id, storage_key);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_staged_uploads_target;
-- +goose StatementEnd
