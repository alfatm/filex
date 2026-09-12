-- +goose Up
-- Revocation is its own fact, not an expiry.
--
-- Revoking a link only set expires_at = NOW, so an admin looking at the Shares
-- list could not tell a link somebody closed from one whose TTL simply ran
-- out — the row looked ordinary, and the user who pressed "Remove" saw it
-- vanish from their side while it stayed in the admin list unexplained.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- +goose Down
ALTER TABLE shares DROP COLUMN IF EXISTS revoked_at;
