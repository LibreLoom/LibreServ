package storage

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

// BackupService handles backup and restore operations
type BackupService struct {
	db           *database.DB
	docker       *docker.Client
	basePath     string // Base path for storing backups
	appDataPath  string // Base path where app data is stored
	cloudService interface {
		IsEnabled() bool
		UploadBackupAsync(backupID, localPath string) error
	}
}

// NewBackupService creates a new backup service
func NewBackupService(db *database.DB, docker *docker.Client, basePath, appDataPath string) *BackupService {
	return &BackupService{
		db:          db,
		docker:      docker,
		basePath:    basePath,
		appDataPath: appDataPath,
	}
}

// BackupApp creates a backup of an app\'s data
func (s *BackupService) BackupApp(ctx context.Context, appID string, opts BackupOptions) (*BackupResult, error) {
	startTime := time.Now()
	result := &BackupResult{}

	log.Printf("BackupApp: starting backup for app %s", appID)

	// Get app info from database
	var appPath, appStatus string
	err := s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", appID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found (id=%s): %w", appID, err)
		log.Printf("BackupApp: app not found (id=%s): %v", appID, err)
		return result, result.Error
	}
	log.Printf("BackupApp: found app at path %s with status %s", appPath, appStatus)

	// Stop app if required
	if opts.StopBeforeBackup && appStatus == "running" {
		log.Printf("Stopping app %s for backup", appID)
		if err := s.docker.ComposeStop(ctx, appPath); err != nil {
			result.Error = fmt.Errorf("failed to stop app: %w", err)
			return result, result.Error
		}
		defer func() {
			// Restart the app
			log.Printf("Restarting app %s after backup", appID)
			_ = s.docker.ComposeUp(ctx, appPath)
		}()
	}

	// Create backup directory
	backupDir := filepath.Join(s.basePath, "apps", appID)
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		result.Error = fmt.Errorf("failed to create backup directory: %w", err)
		return result, result.Error
	}

	// Generate backup ID and filename
	backupID := uuid.New().String()
	timestamp := time.Now().Format("20060102-150405")

	var backupPath string
	if opts.Compress {
		backupPath = filepath.Join(backupDir, fmt.Sprintf("%s-%s.tar.gz", appID, timestamp))
	} else {
		backupPath = filepath.Join(backupDir, fmt.Sprintf("%s-%s.tar", appID, timestamp))
	}

	// Create the tarball
	checksum, size, err := s.createTarball(appPath, backupPath, opts)
	if err != nil {
		result.Error = fmt.Errorf("failed to create backup: %w", err)
		log.Printf("BackupApp: failed to create tarball for app %s from %s: %v", appID, appPath, err)
		return result, result.Error
	}

	// Save backup record to database
	backup := &Backup{
		ID:        backupID,
		AppID:     appID,
		Type:      BackupTypeApp,
		Path:      backupPath,
		Size:      size,
		CreatedAt: time.Now(),
		Checksum:  checksum,
	}

	_, err = s.db.Exec(`
		INSERT INTO backups (id, app_id, type, path, size, created_at, checksum)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, backup.ID, backup.AppID, string(backup.Type), backup.Path, backup.Size, backup.CreatedAt, backup.Checksum)

	if err != nil {
		// Clean up the backup file - best effort, ignore error
		_ = os.Remove(backupPath)
		result.Error = fmt.Errorf("failed to save backup record: %w", err)
		return result, result.Error
	}

	result.Backup = backup
	result.Duration = time.Since(startTime)

	log.Printf("Backup created for %s: %s (%d bytes) in %v", appID, backupPath, size, result.Duration)

	// Trigger cloud upload if configured and enabled
	if s.cloudService != nil && s.cloudService.IsEnabled() {
		go func() {
			if err := s.cloudService.UploadBackupAsync(backup.ID, backupPath); err != nil {
				log.Printf("Cloud backup upload failed for %s: %v", backup.ID, err)
			}
		}()
	}

	return result, nil
}

// SetCloudService configures the cloud backup service for automatic uploads
func (s *BackupService) SetCloudService(cloudService interface {
	IsEnabled() bool
	UploadBackupAsync(backupID, localPath string) error
}) {
	s.cloudService = cloudService
}

// createTarball creates a compressed tarball of a directory
func (s *BackupService) createTarball(srcPath, destPath string, opts BackupOptions) (string, int64, error) {
	// Verify source path exists
	srcInfo, err := os.Stat(srcPath)
	if err != nil {
		return "", 0, fmt.Errorf("source path does not exist or is not accessible: %s: %w", srcPath, err)
	}
	if !srcInfo.IsDir() {
		return "", 0, fmt.Errorf("source path is not a directory: %s", srcPath)
	}

	// Create the destination file
	file, err := os.Create(destPath)
	if err != nil {
		return "", 0, fmt.Errorf("failed to create backup file %s: %w", destPath, err)
	}
	defer func() { _ = file.Close() }()

	// Setup hash writer for checksum
	hash := sha256.New()
	multiWriter := io.MultiWriter(file, hash)

	var writer io.WriteCloser
	if opts.Compress {
		gzWriter := gzip.NewWriter(multiWriter)
		defer gzWriter.Close()
		writer = gzWriter
	} else {
		writer = &nopWriteCloser{Writer: multiWriter}
	}

	tarWriter := tar.NewWriter(writer)
	defer tarWriter.Close()

	// Walk the source directory and add files to the tarball
	err = filepath.Walk(srcPath, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("error accessing %s: %w", path, walkErr)
		}

		// Skip logs if not included
		if !opts.IncludeLogs && filepath.Base(path) == "logs" && info.IsDir() {
			return filepath.SkipDir
		}

		// Create tar header
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return fmt.Errorf("failed to create tar header for %s: %w", path, err)
		}

		// Update the header name to be relative to srcPath
		relPath, err := filepath.Rel(srcPath, path)
		if err != nil {
			return fmt.Errorf("failed to get relative path for %s: %w", path, err)
		}
		header.Name = relPath

		// Write header
		if err := tarWriter.WriteHeader(header); err != nil {
			return fmt.Errorf("failed to write tar header for %s: %w", path, err)
		}

		// If it's a regular file, write its contents
		if !info.IsDir() {
			file, err := os.Open(path)
			if err != nil {
				return fmt.Errorf("failed to open %s: %w", path, err)
			}
			defer func() { _ = file.Close() }()

			if _, err := io.Copy(tarWriter, file); err != nil {
				return fmt.Errorf("failed to copy %s to archive: %w", path, err)
			}
		}

		return nil
	})

	if err != nil {
		_ = os.Remove(destPath)
		return "", 0, fmt.Errorf("failed to walk source directory %s: %w", srcPath, err)
	}

	// Close writers to flush
	_ = tarWriter.Close()
	if opts.Compress {
		_ = writer.Close()
	}

	// Get file size
	fileInfo, err := os.Stat(destPath)
	if err != nil {
		return "", 0, fmt.Errorf("failed to stat backup file %s: %w", destPath, err)
	}

	checksum := hex.EncodeToString(hash.Sum(nil))
	return checksum, fileInfo.Size(), nil
}

// ListBackups returns all backups, optionally filtered by app ID
func (s *BackupService) ListBackups(ctx context.Context, appID string) ([]Backup, error) {
	var query string
	var args []interface{}

	if appID != "" {
		query = `SELECT id, app_id, type, path, size, created_at, checksum FROM backups WHERE app_id = ? ORDER BY created_at DESC`
		args = []interface{}{appID}
	} else {
		query = `SELECT id, app_id, type, path, size, created_at, checksum FROM backups WHERE app_id IS NOT NULL ORDER BY created_at DESC`
	}

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query backups: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	var backups []Backup
	for rows.Next() {
		var b Backup
		var backupType string
		if err := rows.Scan(&b.ID, &b.AppID, &backupType, &b.Path, &b.Size, &b.CreatedAt, &b.Checksum); err != nil {
			continue
		}
		b.Type = BackupType(backupType)
		backups = append(backups, b)
	}

	return backups, nil
}

// GetBackup retrieves a specific backup by ID
func (s *BackupService) GetBackup(ctx context.Context, backupID string) (*Backup, error) {
	var b Backup
	var backupType string

	err := s.db.QueryRow(`
		SELECT id, app_id, type, path, size, created_at, checksum
		FROM backups WHERE id = ?
	`, backupID).Scan(&b.ID, &b.AppID, &backupType, &b.Path, &b.Size, &b.CreatedAt, &b.Checksum)

	if err != nil {
		return nil, fmt.Errorf("backup not found: %w", err)
	}

	b.Type = BackupType(backupType)
	return &b, nil
}

// DeleteBackup removes a backup
func (s *BackupService) DeleteBackup(ctx context.Context, backupID string) error {
	// Get backup info
	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		return err
	}

	// Delete the file
	if err := os.Remove(backup.Path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete backup file: %w", err)
	}

	// Delete from database
	_, err = s.db.Exec("DELETE FROM backups WHERE id = ?", backupID)
	if err != nil {
		return fmt.Errorf("failed to delete backup record: %w", err)
	}

	log.Printf("Backup deleted: %s", backupID)
	return nil
}

// CleanupOldBackups removes backups older than the retention period
func (s *BackupService) CleanupOldBackups(ctx context.Context, appID string, retention int) error {
	// Get all backups for this app, ordered by date
	backups, err := s.ListBackups(ctx, appID)
	if err != nil {
		return err
	}

	// Keep only the most recent 'retention' backups
	if len(backups) <= retention {
		return nil
	}

	// Delete older backups
	for i := retention; i < len(backups); i++ {
		if err := s.DeleteBackup(ctx, backups[i].ID); err != nil {
			log.Printf("Failed to delete old backup %s: %v", backups[i].ID, err)
		}
	}

	return nil
}

// BackupDatabase creates a backup of the LibreServ database
func (s *BackupService) BackupDatabase(ctx context.Context) (*DatabaseBackup, error) {
	// Create backup directory
	backupDir := filepath.Join(s.basePath, "database")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create backup directory: %w", err)
	}

	// Generate backup path
	backupID := uuid.New().String()
	timestamp := time.Now().Format("20060102-150405")
	backupPath := filepath.Join(backupDir, fmt.Sprintf("libreserv-%s.db.gz", timestamp))

	// Use SQLite VACUUM INTO for a consistent backup
	tempPath := backupPath + ".tmp"

	// Validate path to prevent SQL injection via single quotes
	if strings.Contains(tempPath, "'") || strings.Contains(tempPath, "\x00") {
		return nil, fmt.Errorf("invalid characters in backup path")
	}

	_, err := s.db.Exec(fmt.Sprintf("VACUUM INTO '%s'", tempPath))
	if err != nil {
		return nil, fmt.Errorf("database backup failed: %w", err)
	}

	// Compress the backup
	if err := compressFile(tempPath, backupPath); err != nil {
		_ = os.Remove(tempPath)
		return nil, fmt.Errorf("compression failed: %w", err)
	}
	_ = os.Remove(tempPath)

	// Get file info
	fileInfo, err := os.Stat(backupPath)
	if err != nil {
		return nil, err
	}

	// Calculate checksum
	checksum, err := fileChecksum(backupPath)
	if err != nil {
		checksum = ""
	}

	// Save backup record
	backup := &DatabaseBackup{
		ID:        backupID,
		Path:      backupPath,
		Size:      fileInfo.Size(),
		CreatedAt: time.Now(),
		Checksum:  checksum,
	}

	_, err = s.db.Exec(`
		INSERT INTO database_backups (id, path, size, created_at, checksum)
		VALUES (?, ?, ?, ?, ?)
	`, backup.ID, backup.Path, backup.Size, backup.CreatedAt, backup.Checksum)

	if err != nil {
		_ = os.Remove(backupPath)
		return nil, fmt.Errorf("failed to save backup record: %w", err)
	}

	log.Printf("Database backup created: %s (%d bytes)", backupPath, backup.Size)
	return backup, nil
}

// Helper functions

func compressFile(srcPath, destPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()

	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer func() { _ = dest.Close() }()

	gzWriter := gzip.NewWriter(dest)
	defer gzWriter.Close()

	_, err = io.Copy(gzWriter, src)
	return err
}

func fileChecksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

// nopWriteCloser wraps an io.Writer to satisfy io.WriteCloser
type nopWriteCloser struct {
	io.Writer
}

func (nopWriteCloser) Close() error { return nil }

// ListSchedules returns all backup schedules
func (s *BackupService) ListSchedules(ctx context.Context) ([]BackupSchedule, error) {
	query := `SELECT id, app_id, type, cron_expr, enabled, stop_before_backup, compress, include_config, include_logs, retention, last_run, next_run, created_at, updated_at FROM backup_schedules ORDER BY created_at DESC`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query backup schedules: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			log.Printf("failed to close rows: %v", cerr)
		}
	}()

	var schedules []BackupSchedule
	for rows.Next() {
		var bs BackupSchedule
		var scheduleType string
		var lastRun, nextRun sql.NullTime
		if err := rows.Scan(&bs.ID, &bs.AppID, &scheduleType, &bs.CronExpr, &bs.Enabled, &bs.Options.StopBeforeBackup, &bs.Options.Compress, &bs.Options.IncludeConfig, &bs.Options.IncludeLogs, &bs.Retention, &lastRun, &nextRun, &bs.CreatedAt, &bs.UpdatedAt); err != nil {
			log.Printf("failed to scan backup schedule: %v", err)
			continue
		}
		bs.Type = BackupType(scheduleType)
		if lastRun.Valid {
			bs.LastRun = &lastRun.Time
		}
		if nextRun.Valid {
			bs.NextRun = &nextRun.Time
		}
		schedules = append(schedules, bs)
	}

	return schedules, nil
}

// GetSchedule retrieves a specific backup schedule by ID
func (s *BackupService) GetSchedule(ctx context.Context, scheduleID string) (*BackupSchedule, error) {
	var bs BackupSchedule
	var scheduleType string
	var lastRun, nextRun sql.NullTime

	err := s.db.QueryRow(`
		SELECT id, app_id, type, cron_expr, enabled, stop_before_backup, compress, include_config, include_logs, retention, last_run, next_run, created_at, updated_at
		FROM backup_schedules WHERE id = ?
	`, scheduleID).Scan(&bs.ID, &bs.AppID, &scheduleType, &bs.CronExpr, &bs.Enabled, &bs.Options.StopBeforeBackup, &bs.Options.Compress, &bs.Options.IncludeConfig, &bs.Options.IncludeLogs, &bs.Retention, &lastRun, &nextRun, &bs.CreatedAt, &bs.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("backup schedule not found: %w", err)
	}

	bs.Type = BackupType(scheduleType)
	if lastRun.Valid {
		bs.LastRun = &lastRun.Time
	}
	if nextRun.Valid {
		bs.NextRun = &nextRun.Time
	}

	return &bs, nil
}

// CreateSchedule creates a new backup schedule
func (s *BackupService) CreateSchedule(ctx context.Context, schedule *BackupSchedule) error {
	_, err := s.db.Exec(`
		INSERT INTO backup_schedules (id, app_id, type, cron_expr, enabled, stop_before_backup, compress, include_config, include_logs, retention, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, schedule.ID, schedule.AppID, string(schedule.Type), schedule.CronExpr, schedule.Enabled, schedule.Options.StopBeforeBackup, schedule.Options.Compress, schedule.Options.IncludeConfig, schedule.Options.IncludeLogs, schedule.Retention, schedule.CreatedAt, schedule.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create backup schedule: %w", err)
	}

	log.Printf("Backup schedule created: %s", schedule.ID)
	return nil
}

// UpdateSchedule updates an existing backup schedule
func (s *BackupService) UpdateSchedule(ctx context.Context, schedule *BackupSchedule) error {
	_, err := s.db.Exec(`
		UPDATE backup_schedules SET cron_expr = ?, enabled = ?, stop_before_backup = ?, compress = ?, include_config = ?, include_logs = ?, retention = ?, updated_at = ? WHERE id = ?
	`, schedule.CronExpr, schedule.Enabled, schedule.Options.StopBeforeBackup, schedule.Options.Compress, schedule.Options.IncludeConfig, schedule.Options.IncludeLogs, schedule.Retention, time.Now(), schedule.ID)

	if err != nil {
		return fmt.Errorf("failed to update backup schedule: %w", err)
	}

	log.Printf("Backup schedule updated: %s", schedule.ID)
	return nil
}

// DeleteSchedule removes a backup schedule
func (s *BackupService) DeleteSchedule(ctx context.Context, scheduleID string) error {
	_, err := s.db.Exec("DELETE FROM backup_schedules WHERE id = ?", scheduleID)
	if err != nil {
		return fmt.Errorf("failed to delete backup schedule: %w", err)
	}

	log.Printf("Backup schedule deleted: %s", scheduleID)
	return nil
}

// BasePath returns the base path for backups
func (s *BackupService) BasePath() string {
	return s.basePath
}

// StoreUploadedBackup stores an uploaded backup file
func (s *BackupService) StoreUploadedBackup(ctx context.Context, filename string, content io.Reader, size int64) (*Backup, error) {
	uploadID := uuid.New().String()
	uploadDir := filepath.Join(s.basePath, "uploads", uploadID)

	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create upload directory: %w", err)
	}

	destPath := filepath.Join(uploadDir, filename)

	f, err := os.Create(destPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create backup file: %w", err)
	}

	hash := sha256.New()
	multiWriter := io.MultiWriter(f, hash)

	written, err := io.Copy(multiWriter, content)
	if err != nil {
		f.Close()
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to write backup file: %w", err)
	}
	f.Close()

	checksum := hex.EncodeToString(hash.Sum(nil))

	backup := &Backup{
		ID:        uuid.New().String(),
		Type:      BackupTypeApp,
		Path:      destPath,
		Size:      written,
		CreatedAt: time.Now(),
		Checksum:  checksum,
		Source:    "uploaded",
	}

	_, err = s.db.Exec(`
		INSERT INTO backups (id, type, path, size, created_at, checksum, source)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, backup.ID, string(backup.Type), backup.Path, backup.Size, backup.CreatedAt, backup.Checksum, backup.Source)
	if err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to save backup record: %w", err)
	}

	log.Printf("Uploaded backup stored: %s (%d bytes)", backup.ID, backup.Size)
	return backup, nil
}

// ListUnattachedBackups lists backups not linked to any installed app
func (s *BackupService) ListUnattachedBackups(ctx context.Context) ([]*Backup, error) {
	rows, err := s.db.Query(`
		SELECT id, app_id, type, path, size, created_at, checksum, source
		FROM backups
		WHERE app_id IS NULL OR app_id NOT IN (SELECT id FROM apps)
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query unattached backups: %w", err)
	}
	defer rows.Close()

	var backups []*Backup
	for rows.Next() {
		var b Backup
		var appID, source sql.NullString
		if err := rows.Scan(&b.ID, &appID, &b.Type, &b.Path, &b.Size, &b.CreatedAt, &b.Checksum, &source); err != nil {
			log.Printf("failed to scan unattached backup: %v", err)
			continue
		}
		if appID.Valid {
			b.AppID = appID.String
		}
		if source.Valid {
			b.Source = source.String
		}
		backups = append(backups, &b)
	}

	return backups, nil
}

// StoreUploadedDatabaseBackup stores an uploaded database backup file
func (s *BackupService) StoreUploadedDatabaseBackup(ctx context.Context, filename string, content io.Reader, size int64) (*DatabaseBackup, error) {
	backupID := uuid.New().String()
	backupDir := filepath.Join(s.basePath, "database")

	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create database backup directory: %w", err)
	}

	destPath := filepath.Join(backupDir, filename)

	f, err := os.Create(destPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create database backup file: %w", err)
	}

	hash := sha256.New()
	multiWriter := io.MultiWriter(f, hash)

	written, err := io.Copy(multiWriter, content)
	if err != nil {
		f.Close()
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to write database backup file: %w", err)
	}
	f.Close()

	checksum := hex.EncodeToString(hash.Sum(nil))

	backup := &DatabaseBackup{
		ID:        backupID,
		Path:      destPath,
		Size:      written,
		CreatedAt: time.Now(),
		Checksum:  checksum,
	}

	_, err = s.db.Exec(`
		INSERT INTO database_backups (id, path, size, created_at, checksum)
		VALUES (?, ?, ?, ?, ?)
	`, backup.ID, backup.Path, backup.Size, backup.CreatedAt, backup.Checksum)
	if err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to save database backup record: %w", err)
	}

	log.Printf("Uploaded database backup stored: %s (%d bytes)", backup.ID, backup.Size)
	return backup, nil
}
