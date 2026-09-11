-- +goose Up
-- +goose StatementBegin

-- Per-role OPERATION permissions (internal/perm).
--
-- roles.permissions_json has existed since 00001 and nothing ever read it: the
-- four values it held ("files.read", "files.write", "files.delete",
-- "files.share") were documentation, while enforcement came entirely from the
-- role STRING (acl.RoleCeiling) plus per-item grants. This migration replaces
-- that dead vocabulary with the one the handlers now actually check, so the
-- column stops being a lie and an operator can take, say, "delete forever"
-- away from the `user` role without touching a single grant.
--
-- The rewrite is deliberately NOT a behaviour change: `user` receives every
-- operation (exactly what it could do yesterday) and `viewer` receives
-- download + star (exactly what the viewer ceiling already allowed it to do).
-- Legacy mapping, for the record and for the Down direction:
--   files.read   -> files.download, files.star
--   files.write  -> files.upload, files.mkdir, files.rename, files.move,
--                   files.copy, files.tags, files.restore
--   files.delete -> files.delete, files.purge
--   files.share  -> files.share, files.grant
--   *            -> unchanged (admin)

INSERT OR IGNORE INTO roles (name, permissions_json) VALUES
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
