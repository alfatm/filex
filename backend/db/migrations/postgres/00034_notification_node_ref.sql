-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00034_notification_node_ref.sql for the rationale:
-- a file event is persisted with its node inside meta_json, which cannot answer
-- "what happened to this file" without scanning and parsing every row.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS node_storage_id BIGINT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS node_path TEXT;

CREATE INDEX IF NOT EXISTS idx_notifications_node
    ON notifications (node_storage_id, node_path, created_at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_notifications_node;
ALTER TABLE notifications DROP COLUMN IF EXISTS node_path;
ALTER TABLE notifications DROP COLUMN IF EXISTS node_storage_id;
-- +goose StatementEnd
