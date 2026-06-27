-- Invite tokens: admin-initiated account creation (replaces public self-registration).
-- Token is a 32-byte hex bearer; only the SHA-256 hash is stored (mirrors
-- password_reset_tokens). Single-use, expiring.
CREATE TABLE IF NOT EXISTS invite_tokens (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'user',
    inviter_id  TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMP NOT NULL,
    redeemed_at TIMESTAMP,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_hash ON invite_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_email ON invite_tokens(email);