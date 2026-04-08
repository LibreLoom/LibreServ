package storage

import (
	"time"
)

// BackupType represents the type of backup
type BackupType string

// BackupType values for storage backups.
const (
	BackupTypeApp      BackupType = "app"
	BackupTypeSystem   BackupType = "system"
	BackupTypeDatabase BackupType = "database"
)

// Backup represents a backup record
type Backup struct {
	ID          string                 `json:"id"`
	AppID       string                 `json:"app_id,omitempty"`
	Type        BackupType             `json:"type"`
	Path        string                 `json:"path"`
	Size        int64                  `json:"size"`
	CreatedAt   time.Time              `json:"created_at"`
	Checksum    string                 `json:"checksum,omitempty"`
	Source      string                 `json:"source,omitempty"` // 'local', 'uploaded', 'cloud'
	CloudStatus map[string]interface{} `json:"cloud_status,omitempty"`
}

// BackupOptions configures how a backup is created
type BackupOptions struct {
	// StopBeforeBackup stops the app before backing up (safer but downtime)
	StopBeforeBackup bool `json:"stop_before_backup"`
	// Compress the backup archive
	Compress bool `json:"compress"`
	// IncludeConfig includes configuration files
	IncludeConfig bool `json:"include_config"`
	// IncludeLogs includes log files
	IncludeLogs bool `json:"include_logs"`
}

// RestoreOptions configures how a restore is performed
type RestoreOptions struct {
	// StopBeforeRestore stops the app before restoring
	StopBeforeRestore bool `json:"stop_before_restore"`
	// RestartAfterRestore restarts the app after restoring
	RestartAfterRestore bool `json:"restart_after_restore"`
	// VerifyChecksum verifies the backup integrity before restoring
	VerifyChecksum bool `json:"verify_checksum"`
}

// BackupSchedule defines when automatic backups run
type BackupSchedule struct {
	ID        string        `json:"id"`
	AppID     string        `json:"app_id,omitempty"` // Empty for system backups
	Type      BackupType    `json:"type"`
	CronExpr  string        `json:"cron_expr"` // Cron expression (e.g., "0 2 * * *" for 2 AM daily)
	Enabled   bool          `json:"enabled"`
	Options   BackupOptions `json:"options"`
	Retention int           `json:"retention"` // Number of backups to keep
	LastRun   *time.Time    `json:"last_run,omitempty"`
	NextRun   *time.Time    `json:"next_run,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// DatabaseBackup represents a database backup record
type DatabaseBackup struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
	Checksum  string    `json:"checksum,omitempty"`
}

// DatabaseRestoreOptions configures how a database restore is performed.
type DatabaseRestoreOptions struct {
	// VerifyChecksum verifies the backup integrity before restoring.
	// If true and the backup record has no checksum, restore will fail.
	VerifyChecksum bool `json:"verify_checksum"`
}

// BackupResult is the result of a backup operation
type BackupResult struct {
	Backup   *Backup       `json:"backup"`
	Duration time.Duration `json:"duration"`
	Error    error         `json:"error,omitempty"`
}

// RestoreResult is the result of a restore operation
type RestoreResult struct {
	BackupID string        `json:"backup_id"`
	Duration time.Duration `json:"duration"`
	Error    error         `json:"error,omitempty"`
}
