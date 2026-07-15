-- OIDC Provider: client registrations, user consent, app access control,
-- and signing key storage. LibreServ acts as an OpenID Connect Identity
-- Provider for apps with access_model = "internal".

-- OIDC client registrations (one per "internal" app instance).
-- Created automatically at app install time when access_model = internal.
CREATE TABLE IF NOT EXISTS oidc_clients (
    id            TEXT PRIMARY KEY,       -- internal UUID
    instance_id   TEXT NOT NULL,          -- references installed app instance
    client_id     TEXT UNIQUE NOT NULL,    -- OIDC client_id (e.g. nextcloud-<uuid>)
    client_secret TEXT NOT NULL,           -- bcrypt-hashed
    redirect_uris TEXT NOT NULL DEFAULT '[]', -- JSON array of allowed redirect URIs
    scopes        TEXT NOT NULL DEFAULT 'openid profile email',
    name          TEXT NOT NULL DEFAULT '', -- human-friendly label
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_oidc_clients_instance ON oidc_clients(instance_id);
CREATE INDEX IF NOT EXISTS idx_oidc_clients_client_id ON oidc_clients(client_id);

-- User consent records — so users don't re-consent on every login.
CREATE TABLE IF NOT EXISTS oidc_consent (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    client_id   TEXT NOT NULL,  -- references oidc_clients.client_id
    scopes      TEXT NOT NULL,
    granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oidc_consent_user ON oidc_consent(user_id);

-- App access control — which users can access which app instances.
CREATE TABLE IF NOT EXISTS app_access (
    user_id     TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, instance_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_access_instance ON app_access(instance_id);

-- OIDC signing keys — RSA keypairs for signing ID tokens (RS256).
-- Private key encrypted at rest with the cloud encryption key.
CREATE TABLE IF NOT EXISTS oidc_signing_keys (
    id           TEXT PRIMARY KEY,
    key_pem      TEXT NOT NULL,    -- RSA private key PEM, encrypted
    public_pem   TEXT NOT NULL,    -- RSA public key PEM (not encrypted)
    algorithm    TEXT NOT NULL DEFAULT 'RS256',
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   TIMESTAMP,        -- NULL = no expiry (current key)
    is_current   INTEGER NOT NULL DEFAULT 1
);

-- Add restricted_access column to routes table for forward_auth support.
-- When true, Caddy checks with LibreServ before proxying (logged-in users only).
ALTER TABLE routes ADD COLUMN restricted_access INTEGER NOT NULL DEFAULT 0;
