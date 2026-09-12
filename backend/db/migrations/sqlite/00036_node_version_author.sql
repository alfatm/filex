-- +goose Up
-- Who wrote a revision. `node_versions` has recorded size and instant since the
-- first migration and never who did it, so the versions panel could only name the
-- person looking at it — the same wrong name on every row, including revisions
-- written by somebody else.
--
-- Nullable and NOT backfilled: nobody recorded the author of the revisions that
-- already exist, and inventing one is what this migration is here to stop. Those
-- rows keep an empty author and the panel simply omits the name.
ALTER TABLE node_versions ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE node_versions DROP COLUMN created_by;
