-- +goose Up
-- +goose StatementBegin

-- See db/migrations/sqlite/00044_role_op_permissions.sql for the rationale and
-- the legacy -> operation mapping.
INSERT INTO roles (name, permissions_json) VALUES
    ('admin',  '["*"]'::jsonb),
    ('user',   '[]'::jsonb),
    ('viewer', '[]'::jsonb)
ON CONFLICT (name) DO NOTHING;

UPDATE roles SET permissions_json='["*"]'::jsonb WHERE name='admin';
UPDATE roles SET permissions_json='["files.upload","files.mkdir","files.rename","files.move","files.copy","files.delete","files.purge","files.restore","files.tags","files.download","files.star","files.share","files.grant"]'::jsonb WHERE name='user';
UPDATE roles SET permissions_json='["files.download","files.star"]'::jsonb WHERE name='viewer';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE roles SET permissions_json='["*"]'::jsonb WHERE name='admin';
UPDATE roles SET permissions_json='["files.read","files.write","files.delete","files.share"]'::jsonb WHERE name='user';
UPDATE roles SET permissions_json='["files.read"]'::jsonb WHERE name='viewer';
-- +goose StatementEnd
