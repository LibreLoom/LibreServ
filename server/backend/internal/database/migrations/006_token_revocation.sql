-- Token revocation table for JWT token revocation (#18)
CREATE TABLE IF NOT EXISTS revoked_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_jti TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_by TEXT,
    reason TEXT,
    expires_at TIMESTAMP NOT NULL
);

-- Index for quick lookup by JTI
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON revoked_tokens(token_jti);

-- Index for user-based revocation operations
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id, token_type);

-- Cleanup expired revoked tokens periodically
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
