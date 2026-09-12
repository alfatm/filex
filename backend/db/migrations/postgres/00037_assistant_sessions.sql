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
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT '',
    title_manual    BOOLEAN NOT NULL DEFAULT FALSE,
    message_count   INTEGER NOT NULL DEFAULT 0,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user_active
    ON assistant_sessions (user_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
    id              BIGSERIAL PRIMARY KEY,
    session_id      BIGINT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    payload_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    aborted         BOOLEAN NOT NULL DEFAULT FALSE,
    secret_notice   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
    ON assistant_messages (session_id, id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS assistant_messages;
DROP TABLE IF EXISTS assistant_sessions;
-- +goose StatementEnd
