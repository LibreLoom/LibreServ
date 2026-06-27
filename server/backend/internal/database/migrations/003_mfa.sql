-- MFA: methods + recovery codes, and a per-user mfa_required flag
-- (set true for admins; enforced — can't be true without ≥1 enabled method).

CREATE TABLE IF NOT EXISTS mfa_methods (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('totp','email','passkey','security_key')),
    label        TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    data         TEXT,  -- JSON; encrypted where sensitive (totp.secret_enc)
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mfa_methods_user ON mfa_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_methods_user_type ON mfa_methods(user_id, type);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    used_at    TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);

-- Admins must have MFA; set when granted admin or enrolled first method.
ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0;