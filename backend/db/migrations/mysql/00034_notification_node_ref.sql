-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00034_notification_node_ref.sql for the rationale.
--
-- VARCHAR rather than TEXT, and a prefix in the index: MySQL cannot index a
-- TEXT column without one, and a path long enough to overflow 1024 characters
-- is past what any storage driver accepts as a key.
ALTER TABLE notifications ADD COLUMN node_storage_id BIGINT NULL;
ALTER TABLE notifications ADD COLUMN node_path VARCHAR(1024) NULL;

CREATE INDEX idx_notifications_node
    ON notifications (node_storage_id, node_path(255), created_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_notifications_node ON notifications;
ALTER TABLE notifications DROP COLUMN node_path;
ALTER TABLE notifications DROP COLUMN node_storage_id;
-- +goose StatementEnd
