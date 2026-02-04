-- Security events and monitoring tables
-- Tracks security-relevant events for notification and audit purposes

-- Security events table
CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,           -- login_success, login_failed, logout, password_changed, account_locked, etc.
    severity TEXT NOT NULL,             -- info, warning, critical
    actor_id TEXT,                      -- User ID who performed the action (NULL for anonymous)
    actor_username TEXT,                -- Username for display
    ip_address TEXT,                    -- Source IP address
    user_agent TEXT,                    -- User agent string
    details TEXT,                       -- Human-readable description
    metadata JSON,                      -- Structured data (location, device info, etc.)
    notified BOOLEAN DEFAULT 0          -- Whether notification was sent
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_notified ON security_events(notified);

-- Failed login attempts tracking (for rate limiting and detection)
CREATE TABLE IF NOT EXISTS failed_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    username TEXT,
    ip_address TEXT NOT NULL,
    user_agent TEXT,
    reason TEXT                           -- Why it failed
);

CREATE INDEX IF NOT EXISTS idx_failed_logins_timestamp ON failed_login_attempts(timestamp);
CREATE INDEX IF NOT EXISTS idx_failed_logins_ip ON failed_login_attempts(ip_address);
CREATE INDEX IF NOT EXISTS idx_failed_logins_username ON failed_login_attempts(username);

-- Security settings per user
CREATE TABLE IF NOT EXISTS user_security_settings (
    user_id TEXT PRIMARY KEY,
    notifications_enabled BOOLEAN DEFAULT 1,
    notification_frequency TEXT DEFAULT 'normal',  -- instant, normal, digest
    notify_on_login BOOLEAN DEFAULT 1,
    notify_on_failed_login BOOLEAN DEFAULT 1,
    notify_on_password_change BOOLEAN DEFAULT 1,
    notify_on_admin_action BOOLEAN DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
