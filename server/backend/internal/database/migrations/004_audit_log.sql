-- General audit log for administrative actions
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actor_id TEXT,           -- User ID who performed the action
    actor_username TEXT,     -- Username for easier display
    action TEXT NOT NULL,    -- e.g., "app.install", "route.create", "system.update"
    target_id TEXT,          -- ID of the affected resource (app_id, route_id, etc.)
    target_name TEXT,        -- Name of the affected resource
    status TEXT NOT NULL,    -- "success" or "failure"
    message TEXT,            -- Additional details or error message
    metadata JSON,           -- Any extra context (IP address, old/new values)
    ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
