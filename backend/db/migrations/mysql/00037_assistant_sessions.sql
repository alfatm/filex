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
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    title           VARCHAR(255) NOT NULL DEFAULT '',
    title_manual    TINYINT(1) NOT NULL DEFAULT 0,
    message_count   INT NOT NULL DEFAULT 0,
    last_active_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assistant_sessions_user_active (user_id, last_active_at),
    CONSTRAINT fk_assistant_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assistant_messages (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id      BIGINT NOT NULL,
    role            VARCHAR(16) NOT NULL,
    content         MEDIUMTEXT NOT NULL,
    payload_json    JSON NOT NULL,
    aborted         TINYINT(1) NOT NULL DEFAULT 0,
    secret_notice   TINYINT(1) NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assistant_messages_session (session_id, id),
    CONSTRAINT fk_assistant_messages_session FOREIGN KEY (session_id) REFERENCES assistant_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS assistant_messages;
DROP TABLE IF EXISTS assistant_sessions;
-- +goose StatementEnd
