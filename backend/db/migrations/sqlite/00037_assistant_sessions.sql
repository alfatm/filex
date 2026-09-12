-- +goose Up
-- +goose StatementBegin

-- The assistant's chat history, kept per user.
--
-- TWO TABLES ON PURPOSE. A session's TITLE is metadata an administrator may see
-- (it is generated under a prompt that forbids putting anything from the
-- conversation into it); the MESSAGES are the conversation itself and no
-- administrator may read them. Splitting them means that rule is enforced by
-- there being no admin query against assistant_messages at all, rather than by
-- a WHERE clause somebody could forget.
CREATE TABLE IF NOT EXISTS assistant_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT '',
    -- Set once a person renames it by hand; after that the title generator
    -- leaves it alone.
    title_manual    INTEGER NOT NULL DEFAULT 0,
    message_count   INTEGER NOT NULL DEFAULT 0,
    -- Eviction orders by this, NOT by created_at: a conversation somebody
    -- returns to every week is not old, however long ago it started.
    last_active_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user_active
    ON assistant_sessions (user_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    -- Tool calls, result cards and approval records as JSON; the shape belongs
    -- to the assistant service, not to the schema.
    payload_json    TEXT NOT NULL DEFAULT '{}',
    -- A turn the person stopped part-way. The partial answer stays: they hit
    -- stop having read the beginning, and the beginning is usually the point.
    aborted         INTEGER NOT NULL DEFAULT 0,
    -- Set when the agent reported that it had read something sensitive, so the
    -- interface can mark the message rather than leaving it in prose.
    secret_notice   INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
    ON assistant_messages (session_id, id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS assistant_messages;
DROP TABLE IF EXISTS assistant_sessions;
-- +goose StatementEnd
