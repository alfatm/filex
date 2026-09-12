-- +goose Up
-- Who wrote a revision. `node_versions` has recorded size and instant since the
-- first migration and never who did it, so the versions panel could only name the
-- person looking at it — the same wrong name on every row, including revisions
-- written by somebody else.
--
-- Nullable and NOT backfilled: nobody recorded the author of the revisions that
-- already exist, and inventing one is what this migration is here to stop. Those
-- rows keep an empty author and the panel simply omits the name.
--
-- The foreign key is declared as a table constraint, not inline on the column:
-- MySQL parses an inline `REFERENCES` and then IGNORES it, so the key and its
-- ON DELETE SET NULL would never have been created and a deleted user would
-- leave a dangling id here — where sqlite and postgres null it out. BIGINT to
-- match users.id; the INTEGER this used to say could not have carried a real FK
-- either.
ALTER TABLE node_versions ADD COLUMN created_by BIGINT NULL;
ALTER TABLE node_versions ADD CONSTRAINT fk_node_versions_created_by
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE node_versions DROP FOREIGN KEY fk_node_versions_created_by;
ALTER TABLE node_versions DROP COLUMN created_by;
