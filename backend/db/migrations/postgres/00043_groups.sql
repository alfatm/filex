-- +goose Up
-- +goose StatementBegin

-- User groups — see the SQLite copy of this migration for the rationale.
-- "groups" is a non-reserved keyword in PostgreSQL and needs no quoting.
CREATE TABLE IF NOT EXISTS groups (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    provider_id BIGINT REFERENCES providers(id) ON DELETE CASCADE,
    created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_provider_name ON groups(provider_id, name);

CREATE TABLE IF NOT EXISTS group_members (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS file_group_grants (
    id          BIGSERIAL PRIMARY KEY,
    storage_id  BIGINT NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
    path_prefix TEXT NOT NULL DEFAULT '',
    is_dir      BOOLEAN NOT NULL DEFAULT TRUE,
    group_id    BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    level       TEXT NOT NULL,
    created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_group_grants_uniq ON file_group_grants(storage_id, path_prefix, group_id);
CREATE INDEX IF NOT EXISTS idx_file_group_grants_group ON file_group_grants(group_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS file_group_grants;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
-- +goose StatementEnd
