-- Migration 010: Cloud backup configuration and tracking

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

CREATE TABLE IF NOT EXISTS cloud_backups (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_backups_backup_id ON cloud_backups(backup_id);
CREATE INDEX IF NOT EXISTS idx_cloud_backups_uploaded_at ON cloud_backups(uploaded_at);
