-- Complete LibreServ Database Schema
-- All migrations consolidated into a single file (formerly 001–009).

-- =====================
-- Core Tables
-- =====================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    mfa_required INTEGER NOT NULL DEFAULT 0
);

-- Apps table
CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('repo', 'external')),
    source TEXT,
    path TEXT NOT NULL,
    status TEXT DEFAULT 'stopped',
    health_status TEXT DEFAULT 'unknown',
    pinned_version TEXT,
    error TEXT,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSON,
    image_digest TEXT,
    compose_template_sha TEXT,
    revocation_severity TEXT,
    revocation_reason TEXT,
    revocation_revoked_at TIMESTAMP,
    revocation_acknowledged_at TIMESTAMP
);

-- Health checks table
CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    check_type TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Metrics table
CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cpu_percent REAL,
    memory_usage INTEGER,
    memory_limit INTEGER,
    network_rx INTEGER,
    network_tx INTEGER,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Updates table
CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    status TEXT NOT NULL,
    old_version TEXT,
    new_version TEXT,
    backup_id TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    error TEXT,
    rolled_back BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Backups table (preserves backups when app is deleted)
CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('app', 'system')),
    path TEXT NOT NULL,
    size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    checksum TEXT,
    source TEXT DEFAULT 'local' CHECK(source IN ('local', 'uploaded', 'cloud')),
    format TEXT DEFAULT 'tar',
    snapshot_id TEXT,
    repo_id TEXT,
    data_added INTEGER DEFAULT 0,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL
);

-- Database backups table
CREATE TABLE IF NOT EXISTS database_backups (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    checksum TEXT
);

-- Routes table
CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    subdomain TEXT NOT NULL,
    domain TEXT NOT NULL,
    backend TEXT NOT NULL,
    app_id TEXT,
    ssl BOOLEAN DEFAULT TRUE,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    restricted_access INTEGER NOT NULL DEFAULT 0,
    UNIQUE(subdomain, domain)
);

-- Backup schedules table
CREATE TABLE IF NOT EXISTS backup_schedules (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('app', 'system')),
    cron_expr TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    stop_before_backup BOOLEAN DEFAULT FALSE,
    compress BOOLEAN DEFAULT TRUE,
    include_config BOOLEAN DEFAULT TRUE,
    include_logs BOOLEAN DEFAULT FALSE,
    retention INTEGER DEFAULT 7,
    last_run TIMESTAMP,
    next_run TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Backup repositories: restic-backed local or cloud repos
CREATE TABLE IF NOT EXISTS backup_repositories (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    repo_type TEXT NOT NULL CHECK(repo_type IN ('local', 's3', 'b2', 'sftp')),
    repo_path TEXT NOT NULL,
    password TEXT NOT NULL,
    credentials TEXT,
    is_system BOOLEAN DEFAULT 0,
    limit_upload_kbps INTEGER DEFAULT 0,
    limit_download_kbps INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Token revocation table
CREATE TABLE IF NOT EXISTS revoked_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_jti TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_by TEXT,
    reason TEXT,
    expires_at TIMESTAMP NOT NULL
);

-- Security events table
CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    actor_id TEXT,
    actor_username TEXT,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT,
    metadata JSON,
    notified BOOLEAN DEFAULT 0
);

-- Failed login attempts
CREATE TABLE IF NOT EXISTS failed_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    username TEXT,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    reason TEXT
);

-- Account lockouts
CREATE TABLE IF NOT EXISTS account_lockouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    locked_until TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User security settings
CREATE TABLE IF NOT EXISTS user_security_settings (
    user_id TEXT PRIMARY KEY,
    notifications_enabled BOOLEAN DEFAULT 1,
    notification_frequency TEXT DEFAULT 'normal',
    notify_on_login BOOLEAN DEFAULT 1,
    notify_on_failed_login BOOLEAN DEFAULT 1,
    notify_on_password_change BOOLEAN DEFAULT 1,
    notify_on_admin_action BOOLEAN DEFAULT 1,
    notify_on_health_alert BOOLEAN DEFAULT TRUE,
    notify_on_disk_warning BOOLEAN DEFAULT TRUE,
    notify_on_docker_failure BOOLEAN DEFAULT TRUE,
    notify_on_database_issue BOOLEAN DEFAULT TRUE,
    notify_on_app_updates BOOLEAN DEFAULT 1,
    notify_on_user_management BOOLEAN DEFAULT 1,
    use_12_hour_time BOOLEAN DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actor_id TEXT,
    actor_username TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    target_name TEXT,
    status TEXT NOT NULL,
    message TEXT,
    metadata JSON,
    ip_address TEXT
);

-- App settings
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'string',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Setup state
CREATE TABLE IF NOT EXISTS setup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,
    nonce TEXT NOT NULL,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    current_step TEXT NOT NULL DEFAULT 'checking',
    current_sub_step TEXT,
    step_data TEXT DEFAULT '{}',
    progress_updated_at TIMESTAMP
);

-- Agent conversations
CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    trigger_type TEXT NOT NULL DEFAULT 'user_request',
    trigger_app_id TEXT,
    plan_id TEXT NOT NULL DEFAULT 'free',
    permission_mode TEXT NOT NULL DEFAULT 'standard',
    model TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (trigger_app_id) REFERENCES apps(id)
);

-- Conversation messages (main chat + CoT distinguished by visibility)
CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    visibility TEXT NOT NULL DEFAULT 'chat',
    tool_calls TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
);

-- Tool calls (normalized for audit and tracking)
CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_args TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    snapshot_id TEXT,
    approved_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    executed_at TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE
);

-- Permission grants
CREATE TABLE IF NOT EXISTS permission_grants (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    grant_type TEXT NOT NULL,
    resource TEXT NOT NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    granted_by TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
);

-- Credit usage (per-action, for metering)
CREATE TABLE IF NOT EXISTS credit_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
);

-- conversation_events stores the agent event stream for each conversation
-- so the UI can replay the deliberation trace after a page reload.
CREATE TABLE IF NOT EXISTS conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
);

-- User subscriptions
CREATE TABLE IF NOT EXISTS user_subscriptions (
    user_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    billing_cycle_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    billing_cycle_end TIMESTAMP,
    support_server_token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- DNS provider configuration (includes RFC 2136 / BYO DNS fields)
CREATE TABLE IF NOT EXISTS dns_provider_configs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    domain TEXT NOT NULL,
    api_token TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    nameserver TEXT NOT NULL DEFAULT '',
    tsig_key_name TEXT NOT NULL DEFAULT '',
    tsig_secret TEXT NOT NULL DEFAULT '',
    hmac_algorithm TEXT NOT NULL DEFAULT 'hmac-sha256'
);

-- Password reset tokens table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Email templates table
CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_key TEXT UNIQUE NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    is_custom BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
);

-- API tokens for programmatic access (distinct from JWT session tokens).
-- The plaintext token is shown once at creation; only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    revoked_at   TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- MFA: methods + recovery codes
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

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    used_at    TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Invite tokens: admin-initiated account creation (replaces public self-registration).
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

-- OIDC client registrations (one per "internal" app instance).
CREATE TABLE IF NOT EXISTS oidc_clients (
    id            TEXT PRIMARY KEY,
    instance_id   TEXT NOT NULL,
    client_id     TEXT UNIQUE NOT NULL,
    client_secret TEXT NOT NULL,
    redirect_uris TEXT NOT NULL DEFAULT '[]',
    scopes        TEXT NOT NULL DEFAULT 'openid profile email',
    name          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User consent records — so users don't re-consent on every login.
CREATE TABLE IF NOT EXISTS oidc_consent (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    scopes      TEXT NOT NULL,
    granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- App access control — which users can access which app instances.
CREATE TABLE IF NOT EXISTS app_access (
    user_id     TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, instance_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- OIDC signing keys — RSA keypairs for signing ID tokens (RS256).
CREATE TABLE IF NOT EXISTS oidc_signing_keys (
    id           TEXT PRIMARY KEY,
    key_pem      TEXT NOT NULL,
    public_pem   TEXT NOT NULL,
    algorithm    TEXT NOT NULL DEFAULT 'RS256',
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   TIMESTAMP,
    is_current   INTEGER NOT NULL DEFAULT 1
);

-- Network exposure path state: one row per app × path × protocol × port.
CREATE TABLE IF NOT EXISTS path_state (
    id INTEGER PRIMARY KEY,
    app_id TEXT NOT NULL,
    path TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    last_verified_at INTEGER,
    last_failure_at INTEGER,
    last_failure_reason TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (app_id, path, protocol, port)
);

-- =====================
-- Indexes
-- =====================

-- Users indexes
-- Email is optional, so uniqueness is only enforced for real addresses;
-- multiple users may have a blank/NULL email.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON users(email)
    WHERE email IS NOT NULL AND email != '';

-- Apps indexes
CREATE INDEX IF NOT EXISTS idx_apps_type ON apps(type);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);

-- Health checks indexes
CREATE INDEX IF NOT EXISTS idx_health_checks_app ON health_checks(app_id, checked_at);

-- Metrics indexes
CREATE INDEX IF NOT EXISTS idx_metrics_app_time ON metrics(app_id, timestamp);

-- Updates indexes
CREATE INDEX IF NOT EXISTS idx_updates_app ON updates(app_id, started_at);

-- Backups indexes
CREATE INDEX IF NOT EXISTS idx_backups_app ON backups(app_id);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at);
CREATE INDEX IF NOT EXISTS idx_backups_source ON backups(source);

-- Database backups indexes
CREATE INDEX IF NOT EXISTS idx_database_backups_created ON database_backups(created_at);

-- Backup schedules indexes
CREATE INDEX IF NOT EXISTS idx_backup_schedules_app ON backup_schedules(app_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_next_run ON backup_schedules(next_run);

-- Backup repositories indexes
CREATE INDEX IF NOT EXISTS idx_backup_repositories_app ON backup_repositories(app_id);
CREATE INDEX IF NOT EXISTS idx_backup_repositories_type ON backup_repositories(repo_type);

-- Token revocation indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON revoked_tokens(token_jti);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id, token_type);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- Security events indexes
CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_notified ON security_events(notified);
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip_address);

-- Failed login attempts indexes
CREATE INDEX IF NOT EXISTS idx_failed_logins_timestamp ON failed_login_attempts(timestamp);
CREATE INDEX IF NOT EXISTS idx_failed_logins_ip ON failed_login_attempts(ip_address);
CREATE INDEX IF NOT EXISTS idx_failed_logins_username ON failed_login_attempts(username);

-- Account lockouts indexes
CREATE INDEX IF NOT EXISTS idx_account_lockouts_username ON account_lockouts(username);
CREATE INDEX IF NOT EXISTS idx_account_lockouts_locked_until ON account_lockouts(locked_until);

-- Password reset tokens indexes
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- Audit log indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- Agent conversation indexes
CREATE INDEX IF NOT EXISTS idx_agent_conv_user ON agent_conversations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_conv_status ON agent_conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversation_events_conv ON conversation_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_messages_vis ON conversation_messages(conversation_id, visibility);
CREATE INDEX IF NOT EXISTS idx_tool_calls_conv ON tool_calls(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);
CREATE INDEX IF NOT EXISTS idx_credit_usage_user ON credit_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_usage_conv ON credit_usage(conversation_id);

-- API tokens indexes
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- MFA indexes
CREATE INDEX IF NOT EXISTS idx_mfa_methods_user ON mfa_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_methods_user_type ON mfa_methods(user_id, type);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);

-- Invite tokens indexes
CREATE INDEX IF NOT EXISTS idx_invite_tokens_hash ON invite_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_email ON invite_tokens(email);

-- OIDC indexes
CREATE INDEX IF NOT EXISTS idx_oidc_clients_instance ON oidc_clients(instance_id);
CREATE INDEX IF NOT EXISTS idx_oidc_clients_client_id ON oidc_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_oidc_consent_user ON oidc_consent(user_id);
CREATE INDEX IF NOT EXISTS idx_app_access_instance ON app_access(instance_id);

-- At most one current OIDC signing key (partial unique index).
DROP INDEX IF EXISTS idx_oidc_signing_keys_single_current;
CREATE UNIQUE INDEX idx_oidc_signing_keys_single_current
    ON oidc_signing_keys (is_current)
    WHERE is_current = 1;

-- Path state indexes
CREATE INDEX IF NOT EXISTS idx_path_state_app ON path_state (app_id);

-- =====================
-- Default Data
-- =====================

-- Insert default email templates
INSERT OR IGNORE INTO email_templates (template_key, subject, body, is_custom, updated_at, updated_by) VALUES
('password_reset', 'Reset Your LibreServ Password', 'Hello {{.Username}},

A password reset was requested for your LibreServ account.

Click the link below to reset your password:
{{.ResetLink}}

This link expires in 1 hour.

If you didn''t request this, you can safely ignore this email.

— LibreServ', 0, CURRENT_TIMESTAMP, NULL),
('welcome', 'Welcome to LibreServ!', 'Hello {{.Username}},

Welcome to LibreServ! Your account has been created.

You can now log in and start managing your self-hosted applications.

— LibreServ', 0, CURRENT_TIMESTAMP, NULL),
('health_alert', '⚠️ LibreServ Health Alert', 'Hello,

LibreServ has detected a health issue:

{{.HealthCheck}}

Status: {{.Status}}
Time: {{.Timestamp}}

Please check your system as soon as possible.

— LibreServ', 0, CURRENT_TIMESTAMP, NULL),
('security_alert', 'LibreServ Security Alert', 'Hello {{.Username}},

A security event occurred on your LibreServ:

Event: {{.EventType}}
Time: {{.Timestamp}}
IP: {{.IPAddress}}

If this wasn''t you, please secure your account immediately.

— LibreServ', 0, CURRENT_TIMESTAMP, NULL);
