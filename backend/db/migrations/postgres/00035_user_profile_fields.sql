-- +goose Up
-- Two profile fields the end-user settings modal asks for and the account row had
-- no home for: the person's full name (which is not the DISPLAY name — the display
-- name is what other people see next to a file, and plenty of people set it to
-- something shorter) and their job title.
--
-- Both are optional: nullable, empty means "not set", and nothing in filex requires
-- either. They travel with the account like avatar_url does, so every client of the
-- account reads the same values.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS full_name;
ALTER TABLE users DROP COLUMN IF EXISTS job_title;
