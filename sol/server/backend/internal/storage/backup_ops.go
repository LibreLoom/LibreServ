package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
)

func (s *BackupService) backupDatabaseWithRestic(ctx context.Context, dbFilePath string) error {
	repo, _, err := s.getOrCreateSystemRepo(ctx)
	if err != nil {
		return fmt.Errorf("system repo setup: %w", err)
	}

	dbDir := filepath.Dir(dbFilePath)
	summary, err := s.resticEngine.Backup(ctx, *repo, []string{dbDir}, []string{"libreserv-database", "libreserv"}, nil)
	if err != nil {
		return fmt.Errorf("restic database backup: %w", err)
	}

	log.Printf("Database also backed up with restic: snapshot %s (%d bytes added)", summary.SnapshotID, summary.DataAdded)
	return nil
}

func (s *BackupService) getOrCreateSystemRepo(ctx context.Context) (*restic.RepoConfig, string, error) {
	existing, err := s.getSystemRepository(ctx)
	if err == nil {
		repoConfig := s.buildRepoConfigFromRepository(existing)
		return repoConfig, existing.ID, nil
	}

	repoPath := filepath.Join(s.basePath, "restic-system")
	repo := &BackupRepository{
		ID:        uuid.New().String(),
		AppID:     "",
		RepoType:  "local",
		RepoPath:  repoPath,
		Password:  restic.DeriveRepoPassword(s.serverSecret, "__system__"),
		IsSystem:  true,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.CreateRepository(ctx, repo); err != nil {
		return nil, "", fmt.Errorf("create system repo: %w", err)
	}

	repoConfig := s.buildRepoConfigFromRepository(repo)
	if err := s.resticEngine.EnsureLocalRepo(ctx, *repoConfig); err != nil {
		return nil, "", fmt.Errorf("init system repo: %w", err)
	}

	return repoConfig, repo.ID, nil
}

func (s *BackupService) getSystemRepository(ctx context.Context) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories WHERE is_system = 1 LIMIT 1
	`).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("system repository not found: %w", err)
	}
	return &repo, nil
}

// CreateDownloadArchive restores a restic snapshot to a temp directory and
// creates a downloadable tar.gz archive. Returns the archive path and a
// cleanup function that the caller must invoke after serving the file.
func (s *BackupService) CreateDownloadArchive(ctx context.Context, backupID string) (string, func(), error) {
	if !s.UseRestic() {
		return "", nil, fmt.Errorf("restic is not available")
	}

	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		return "", nil, fmt.Errorf("backup not found: %w", err)
	}

	if backup.Format != BackupFormatRestic || backup.SnapshotID == "" {
		return "", nil, fmt.Errorf("backup is not a restic snapshot and cannot be downloaded")
	}

	repo, err := s.getRepoByBackup(ctx, backup)
	if err != nil {
		return "", nil, fmt.Errorf("repo lookup: %w", err)
	}

	tmpRestoreDir, err := os.MkdirTemp("", "libreserv-download-restore-")
	if err != nil {
		return "", nil, fmt.Errorf("create temp dir: %w", err)
	}

	if err := s.resticEngine.Restore(ctx, *repo, backup.SnapshotID, tmpRestoreDir, nil); err != nil {
		os.RemoveAll(tmpRestoreDir)
		return "", nil, fmt.Errorf("restic restore: %w", err)
	}

	// SECURITY FIX (audit #4): validate restored tree before archiving — a
	// crafted snapshot could contain symlinks that escape the temp dir.
	if err := validateRestoredTree(tmpRestoreDir); err != nil {
		os.RemoveAll(tmpRestoreDir)
		return "", nil, fmt.Errorf("restored tree validation failed: %w", err)
	}

	archiveFile, err := os.CreateTemp("", "libreserv-download-*.tar.gz")
	if err != nil {
		os.RemoveAll(tmpRestoreDir)
		return "", nil, fmt.Errorf("create temp archive: %w", err)
	}
	archivePath := archiveFile.Name()

	if err := createTarGzFromDir(tmpRestoreDir, archiveFile); err != nil {
		archiveFile.Close()
		os.Remove(archivePath)
		os.RemoveAll(tmpRestoreDir)
		return "", nil, fmt.Errorf("create archive: %w", err)
	}
	archiveFile.Close()

	cleanup := func() {
		os.Remove(archivePath)
		os.RemoveAll(tmpRestoreDir)
	}

	return archivePath, cleanup, nil
}

// StoreUploadedDatabaseBackup stores an uploaded database backup file
func (s *BackupService) StoreUploadedDatabaseBackup(ctx context.Context, filename string, content io.Reader, size int64) (*DatabaseBackup, error) {
	backupID := uuid.New().String()
	backupDir := filepath.Join(s.basePath, "database")

	if err := os.MkdirAll(backupDir, 0750); err != nil {
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

// --- Schedule management ---
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
		var compress, includeConfig, includeLogs bool
		if err := rows.Scan(&bs.ID, &bs.AppID, &scheduleType, &bs.CronExpr, &bs.Enabled, &bs.Options.StopBeforeBackup, &compress, &includeConfig, &includeLogs, &bs.Retention, &lastRun, &nextRun, &bs.CreatedAt, &bs.UpdatedAt); err != nil {
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
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate backup schedules: %w", err)
	}

	return schedules, nil
}

func (s *BackupService) GetSchedule(ctx context.Context, scheduleID string) (*BackupSchedule, error) {
	var bs BackupSchedule
	var scheduleType string
	var lastRun, nextRun sql.NullTime
	var compress, includeConfig, includeLogs bool

	err := s.db.QueryRow(`
		SELECT id, app_id, type, cron_expr, enabled, stop_before_backup, compress, include_config, include_logs, retention, last_run, next_run, created_at, updated_at
		FROM backup_schedules WHERE id = ?
	`, scheduleID).Scan(&bs.ID, &bs.AppID, &scheduleType, &bs.CronExpr, &bs.Enabled, &bs.Options.StopBeforeBackup, &compress, &includeConfig, &includeLogs, &bs.Retention, &lastRun, &nextRun, &bs.CreatedAt, &bs.UpdatedAt)

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

func (s *BackupService) CreateSchedule(ctx context.Context, schedule *BackupSchedule) error {
	_, err := s.db.Exec(`
		INSERT INTO backup_schedules (id, app_id, type, cron_expr, enabled, stop_before_backup, compress, include_config, include_logs, retention, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, schedule.ID, schedule.AppID, string(schedule.Type), schedule.CronExpr, schedule.Enabled, schedule.Options.StopBeforeBackup, false, false, false, schedule.Retention, schedule.CreatedAt, schedule.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create backup schedule: %w", err)
	}

	log.Printf("Backup schedule created: %s", schedule.ID)
	return nil
}

func (s *BackupService) UpdateSchedule(ctx context.Context, schedule *BackupSchedule) error {
	_, err := s.db.Exec(`
		UPDATE backup_schedules SET cron_expr = ?, enabled = ?, stop_before_backup = ?, compress = ?, include_config = ?, include_logs = ?, retention = ?, updated_at = ? WHERE id = ?
	`, schedule.CronExpr, schedule.Enabled, schedule.Options.StopBeforeBackup, false, false, false, schedule.Retention, time.Now(), schedule.ID)

	if err != nil {
		return fmt.Errorf("failed to update backup schedule: %w", err)
	}

	log.Printf("Backup schedule updated: %s", schedule.ID)
	return nil
}

func (s *BackupService) DeleteSchedule(ctx context.Context, scheduleID string) error {
	_, err := s.db.Exec("DELETE FROM backup_schedules WHERE id = ?", scheduleID)
	if err != nil {
		return fmt.Errorf("failed to delete backup schedule: %w", err)
	}

	log.Printf("Backup schedule deleted: %s", scheduleID)
	return nil
}

func (s *BackupService) UpdateScheduleNextRun(ctx context.Context, scheduleID string, lastRun, nextRun time.Time) error {
	_, err := s.db.Exec(`
		UPDATE backup_schedules SET last_run = ?, next_run = ?, updated_at = ? WHERE id = ?
	`, lastRun, nextRun, time.Now(), scheduleID)
	if err != nil {
		return fmt.Errorf("failed to update schedule next_run: %w", err)
	}
	return nil
}

func (s *BackupService) BasePath() string {
	return s.basePath
}

// --- Repository management ---
func (s *BackupService) CreateRepository(ctx context.Context, repo *BackupRepository) error {
	if err := restic.ValidateRepoType(repo.RepoType); err != nil {
		return err
	}

	if s.encryptionKey == "" {
		return fmt.Errorf("cloud encryption key not configured — cannot encrypt repository credentials")
	}

	password := repo.Password
	credentials := repo.Credentials
	encKey := s.encryptionKey

	encPassword, err := encryptAESGCM(password, encKey)
	if err != nil {
		return fmt.Errorf("encrypt password: %w", err)
	}
	password = encPassword

	if credentials != "" {
		encCreds, err := encryptAESGCM(credentials, encKey)
		if err != nil {
			return fmt.Errorf("encrypt credentials: %w", err)
		}
		credentials = encCreds
	}

	var appID interface{} = repo.AppID
	if repo.AppID == "" {
		appID = nil
	}

	_, err = s.db.Exec(`
		INSERT INTO backup_repositories (id, app_id, repo_type, repo_path, password, credentials, is_system, limit_upload_kbps, limit_download_kbps, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, repo.ID, appID, repo.RepoType, repo.RepoPath, password, credentials, repo.IsSystem, repo.LimitUploadKbps, repo.LimitDownloadKbps, repo.CreatedAt, repo.UpdatedAt)

	if err != nil {
		return fmt.Errorf("failed to create backup repository: %w", err)
	}

	log.Printf("Backup repository created: %s (type=%s)", repo.ID, repo.RepoType)
	return nil
}
