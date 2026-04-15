-- Complete LibreServ Database Schema
-- Consolidated into single file for simplicity in development

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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Apps table
CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('builtin', 'custom', 'external')),
    source TEXT,
    path TEXT NOT NULL,
    status TEXT DEFAULT 'stopped',
    health_status TEXT DEFAULT 'unknown',
    pinned_version TEXT,
    error TEXT,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSON
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

-- Cloud backup configuration
CREATE TABLE IF NOT EXISTS cloud_backup_config (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    bucket TEXT,
    region TEXT,
    key_id TEXT,
    key_secret TEXT,
    endpoint TEXT,
    enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cloud backups tracking
CREATE TABLE IF NOT EXISTS cloud_backups (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
);

-- Token revocation table
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

-- User security settings
CREATE TABLE IF NOT EXISTS user_security_settings (
    user_id TEXT PRIMARY KEY,
    notifications_enabled BOOLEAN DEFAULT 1,
    notification_frequency TEXT DEFAULT 'normal',
    notify_on_login BOOLEAN DEFAULT 1,
    notify_on_failed_login BOOLEAN DEFAULT 1,
    notify_on_password_change BOOLEAN DEFAULT 1,
    notify_on_admin_action BOOLEAN DEFAULT 1,
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
    completed_at TIMESTAMP
);

-- Support sessions
CREATE TABLE IF NOT EXISTS support_sessions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    token TEXT NOT NULL,
    scopes TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL,
    created_by TEXT,
    revoked_at TIMESTAMP,
    revoked_by TEXT,
    support_level TEXT,
    license_id TEXT
);

-- Support audit log
CREATE TABLE IF NOT EXISTS support_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    actor TEXT,
    action TEXT,
    target TEXT,
    success BOOLEAN,
    message TEXT,
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- DNS provider configuration
CREATE TABLE IF NOT EXISTS dns_provider_configs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    domain TEXT NOT NULL,
    api_token TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================
-- Indexes
-- =====================

-- Users indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);

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

-- Cloud backups indexes
CREATE INDEX IF NOT EXISTS idx_cloud_backups_backup_id ON cloud_backups(backup_id);
CREATE INDEX IF NOT EXISTS idx_cloud_backups_uploaded_at ON cloud_backups(uploaded_at);

-- Token revocation indexes
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON revoked_tokens(token_jti);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_id, token_type);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- Security events indexes
CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_notified ON security_events(notified);

-- Failed login attempts indexes
CREATE INDEX IF NOT EXISTS idx_failed_logins_timestamp ON failed_login_attempts(timestamp);
CREATE INDEX IF NOT EXISTS idx_failed_logins_ip ON failed_login_attempts(ip_address);
CREATE INDEX IF NOT EXISTS idx_failed_logins_username ON failed_login_attempts(username);

-- Audit log indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- Support sessions indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_sessions_code_unique ON support_sessions(code, token);