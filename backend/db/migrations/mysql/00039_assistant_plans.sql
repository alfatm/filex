-- +goose Up
-- +goose StatementBegin

-- A plan of work the assistant proposed, that the person then approved or did
-- not.
--
-- ⚠⚠ THIS TABLE IS WHY THE MODEL HOLDS NO DESTRUCTIVE TOOL. A model that could
-- call "delete" directly would be one prompt injection away from deleting, and
-- no amount of instruction text fixes that. So the model's tools only WRITE A
-- PLAN: every item is resolved here and now — the node id it means, and a
-- fingerprint of the file as it is at this moment — and the plan sits in this
-- table until the person approves it. The SERVER then executes what is written
-- here. The model is not in the loop at execution time and cannot change a
-- single item of it.
--
-- The fingerprint is the second half of that promise. Between proposing and
-- approving, a file can be edited, moved or replaced by somebody else; an item
-- whose fingerprint no longer matches is SKIPPED and reported, because the
-- person approved the file they were shown, not whatever now sits at that path.
CREATE TABLE IF NOT EXISTS assistant_plans (
    id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id  BIGINT NOT NULL,
    -- What kind of work: tags, restore_version, revoke_share, empty_trash.
    -- Each kind has its own executor; there is no generic "run this" path.
    kind        VARCHAR(32) NOT NULL,
    -- The assistant's one-line description, shown above the item list.
    summary     VARCHAR(1024) NOT NULL DEFAULT '',
    -- The items, resolved: path, node id, what will happen to it, and the
    -- fingerprint that has to still match at execution time.
    items_json  MEDIUMTEXT NOT NULL,
    -- pending → done | cancelled. A plan is executed at most once: the
    -- executor refuses anything not pending, so a repeated approval (a double
    -- click, a retried request) cannot run the work twice.
    status      VARCHAR(16) NOT NULL DEFAULT 'pending',
    -- What actually happened, per item, once it ran.
    result_json MEDIUMTEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at  DATETIME NULL,
    CONSTRAINT fk_assistant_plans_session FOREIGN KEY (session_id)
        REFERENCES assistant_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX IF NOT EXISTS idx_assistant_plans_session
    ON assistant_plans (session_id, id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS assistant_plans;
-- +goose StatementEnd
