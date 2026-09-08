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
    id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id  BIGINT NOT NULL,
    -- The full address, `<storage>://<path>`, exactly as the tool was called
    -- with. Comparing anything looser (a prefix, a basename) would turn one
    -- approval into permission for a second file.
    -- 700 rather than the 1024 used elsewhere: this column is part of a UNIQUE
    -- key, and utf8mb4 counts four bytes per character against InnoDB's 3072-byte
    -- index limit. A path longer than 700 characters cannot be approved here —
    -- and a file that deep is not one anybody is granting access to by hand.
    path        VARCHAR(700) NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_assistant_read_grant (session_id, path),
    CONSTRAINT fk_assistant_read_grants_session FOREIGN KEY (session_id)
        REFERENCES assistant_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS assistant_read_grants;
-- +goose StatementEnd
