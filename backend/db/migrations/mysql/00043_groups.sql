-- +goose Up
-- +goose StatementBegin

-- User groups — see the SQLite copy of this migration for the rationale.
-- `groups` is a reserved word in MySQL 8 (window-frame syntax), hence the
-- backticks on every reference.
CREATE TABLE IF NOT EXISTS `groups` (
    id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(191) NOT NULL,
    description TEXT NOT NULL,
    provider_id BIGINT NULL,
    created_by  BIGINT NULL,
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uniq_groups_provider_name (provider_id, name),
    CONSTRAINT fk_groups_provider FOREIGN KEY (provider_id)
        REFERENCES providers(id) ON DELETE CASCADE,
    CONSTRAINT fk_groups_created_by FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS group_members (
    group_id BIGINT NOT NULL,
    user_id  BIGINT NOT NULL,
    added_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (group_id, user_id),
    KEY idx_group_members_user (user_id),
    CONSTRAINT fk_group_members_group FOREIGN KEY (group_id)
        REFERENCES `groups`(id) ON DELETE CASCADE,
    CONSTRAINT fk_group_members_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS file_group_grants (
    id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    storage_id  BIGINT NOT NULL,
    -- 700 rather than TEXT: the column is part of a UNIQUE key and utf8mb4
    -- counts four bytes per character against InnoDB's 3072-byte index limit.
    path_prefix VARCHAR(700) NOT NULL DEFAULT '',
    is_dir      TINYINT(1) NOT NULL DEFAULT 1,
    group_id    BIGINT NOT NULL,
    level       VARCHAR(16) NOT NULL,
    created_by  BIGINT NULL,
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uniq_file_group_grant (storage_id, path_prefix, group_id),
    KEY idx_file_group_grants_group (group_id),
    CONSTRAINT fk_file_group_grants_storage FOREIGN KEY (storage_id)
        REFERENCES storages(id) ON DELETE CASCADE,
    CONSTRAINT fk_file_group_grants_group FOREIGN KEY (group_id)
        REFERENCES `groups`(id) ON DELETE CASCADE,
    CONSTRAINT fk_file_group_grants_created_by FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS file_group_grants;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS `groups`;
-- +goose StatementEnd
