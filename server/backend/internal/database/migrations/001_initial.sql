-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',
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
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    error TEXT,
    rolled_back BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Backups table
CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('app', 'system')),
    path TEXT NOT NULL,
    size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Database backups table (for Recommendation #2)
CREATE TABLE IF NOT EXISTS database_backups (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    checksum TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_apps_type ON apps(type);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);
CREATE INDEX IF NOT EXISTS idx_health_checks_app ON health_checks(app_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_metrics_app_time ON metrics(app_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_updates_app ON updates(app_id, started_at);
CREATE INDEX IF NOT EXISTS idx_database_backups_created ON database_backups(created_at);

-- Setup state (single row to track first-boot wizard)
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_sessions_code_unique ON support_sessions(code, token);

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
