-- +goose Up
-- +goose StatementBegin

-- User groups: a named set of accounts that can be granted access to a path
-- once instead of once per person. A group belongs to a tenant exactly the way
-- a user does (users.provider_id), so a tenant admin never sees or grants to
-- another tenant's group.
--
-- `groups` is a reserved word in MySQL 8 and this file's statements are shared
-- in spirit with the MySQL one, so every reference is backtick-quoted (SQLite
-- accepts backticks for MySQL compatibility).
CREATE TABLE IF NOT EXISTS `groups` (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Scoped to the tenant, not the install: two tenants may both have a "Design"
-- group. Rows with a NULL provider_id (single-tenant installs) are not deduped
-- by this index — the admin handler rejects a duplicate name before writing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_provider_name ON `groups`(provider_id, name);

CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES `groups`(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- The group twin of file_grants. A separate table rather than making
-- file_grants.user_id nullable: SQLite cannot drop a NOT NULL constraint
-- without rebuilding the table, and a rebuild of the live ACL table is not
-- worth the reduction in join count.
CREATE TABLE IF NOT EXISTS file_group_grants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_id  INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
    path_prefix TEXT    NOT NULL DEFAULT '',
    is_dir      INTEGER NOT NULL DEFAULT 1,
    group_id    INTEGER NOT NULL REFERENCES `groups`(id) ON DELETE CASCADE,
    level       TEXT    NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_group_grants_uniq ON file_group_grants(storage_id, path_prefix, group_id);
CREATE INDEX IF NOT EXISTS idx_file_group_grants_group ON file_group_grants(group_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS file_group_grants;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS `groups`;
-- +goose StatementEnd
