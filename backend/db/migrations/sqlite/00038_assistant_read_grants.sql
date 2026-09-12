-- +goose Up
-- +goose StatementBegin

-- Permission to read ONE file's contents, given by the person, inside ONE
-- conversation.
--
-- ⚠⚠ This table is the enforcement, not the prompt. The assistant's standing
-- instructions tell it to ask before opening anything that looks private, and a
-- model can be talked out of any instruction — so the read tool refuses unless a
-- row here names the exact path. There is deliberately no wildcard, no
-- "approve everything" flag and no per-folder form: a blanket permission is
-- precisely what the owner ruled out, and a column that could express one would
-- eventually be set.
--
-- Scoped to the session, so consent does not outlive the conversation it was
-- given in, and cascades with it: deleting a chat deletes what it was allowed
-- to read.
CREATE TABLE IF NOT EXISTS assistant_read_grants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    -- The full address, `<storage>://<path>`, exactly as the tool was called
    -- with. Comparing anything looser (a prefix, a basename) would turn one
    -- approval into permission for a second file.
    path        TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, path)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS assistant_read_grants;
-- +goose StatementEnd
