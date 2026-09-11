-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00044_role_op_permissions.sql for the rationale and
-- the legacy -> operation mapping.
INSERT IGNORE INTO roles (name, permissions_json) VALUES
    ('admin',  '["*"]'),
    ('user',   '[]'),
    ('viewer', '[]');

UPDATE roles SET permissions_json='["*"]' WHERE name='admin';
UPDATE roles SET permissions_json='["files.upload","files.mkdir","files.rename","files.move","files.copy","files.delete","files.purge","files.restore","files.tags","files.download","files.star","files.share","files.grant"]' WHERE name='user';
UPDATE roles SET permissions_json='["files.download","files.star"]' WHERE name='viewer';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE roles SET permissions_json='["*"]' WHERE name='admin';
UPDATE roles SET permissions_json='["files.read","files.write","files.delete","files.share"]' WHERE name='user';
UPDATE roles SET permissions_json='["files.read"]' WHERE name='viewer';
-- +goose StatementEnd
