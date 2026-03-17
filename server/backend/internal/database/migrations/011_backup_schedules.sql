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

CREATE INDEX IF NOT EXISTS idx_backup_schedules_app ON backup_schedules(app_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_next_run ON backup_schedules(next_run);
