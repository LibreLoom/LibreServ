-- Add UNIQUE constraint on users.email via unique index.
-- SQLite does not support ALTER TABLE ADD CONSTRAINT, so we use a unique index.
-- NULL values are considered distinct by SQLite, so multiple users without email are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);
