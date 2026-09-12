-- +goose Up
-- +goose StatementBegin

-- Make a file event findable BY THE FILE it happened to.
--
-- Every write surface already emits one (`file.uploaded`, `file.updated`,
-- `file.moved`, `file.trashed`, `file.deleted`, `share.created`) and the row is
-- already persisted here with the node in meta_json. But meta_json is a blob:
-- answering "what happened to /Docs/notes.md" meant scanning every row and
-- parsing each one, which is why the end-user app's Activity tab had no
-- endpoint behind it and rendered empty against a live server.
--
-- Two columns lifted out of the payload, and the index that makes the question
-- cheap. The bell's own queries are untouched -- they read user_id and event.
ALTER TABLE notifications ADD COLUMN node_storage_id INTEGER;
ALTER TABLE notifications ADD COLUMN node_path TEXT;

CREATE INDEX IF NOT EXISTS idx_notifications_node
    ON notifications (node_storage_id, node_path, created_at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- No backfill on the way up, so nothing to unpick on the way down: history
-- starts at the upgrade. Parsing meta_json for every existing row would spend a
-- long migration on events the app cannot show anyway (a per-node feed of what
-- happened before anyone could read it).
DROP INDEX IF EXISTS idx_notifications_node;
ALTER TABLE notifications DROP COLUMN node_path;
ALTER TABLE notifications DROP COLUMN node_storage_id;
-- +goose StatementEnd
