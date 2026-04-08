-- Add source column to backups table to track origin
-- Values: 'local' (created by LibreServ), 'uploaded' (user uploaded), 'cloud' (downloaded from cloud)

ALTER TABLE backups ADD COLUMN source TEXT DEFAULT 'local'
    CHECK(source IN ('local', 'uploaded', 'cloud'));

CREATE INDEX IF NOT EXISTS idx_backups_source ON backups(source);
