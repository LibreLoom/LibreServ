package storage

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
)

type BackupService struct {
	db            *database.DB
	runtime       *podman.Client
	basePath      string
	appDataPath   string
	resticEngine  *restic.Engine
	resticMu      sync.RWMutex
	serverSecret  string
	encryptionKey string
}

func NewBackupService(db *database.DB, runtime *podman.Client, basePath, appDataPath string) *BackupService {
	svc := &BackupService{
		db:          db,
		runtime:     runtime,
		basePath:    basePath,
		appDataPath: appDataPath,
	}

	if engine, err := restic.NewEngine(); err == nil {
		svc.resticEngine = engine
		log.Printf("BackupService: restic engine initialized (binary found)")
	} else {
		go func() {
			if _, provErr := restic.AutoProvision(); provErr != nil {
				log.Printf("BackupService: restic auto-provision failed: %v", provErr)
				return
			}
			if engine, initErr := restic.NewEngine(); initErr == nil {
				svc.resticMu.Lock()
				svc.resticEngine = engine
				svc.resticMu.Unlock()
				log.Printf("BackupService: restic engine initialized (auto-provisioned)")
			}
		}()
		log.Printf("BackupService: restic not available, attempting auto-provision: %v", err)
	}

	return svc
}

// ProvisionRestic attempts to download and initialize the restic binary.
// Returns true if restic is now available after provisioning.
func (s *BackupService) ProvisionRestic() (bool, error) {
	if s.UseRestic() {
		return true, nil
	}

	path, err := restic.AutoProvision()
	if err != nil {
		return false, fmt.Errorf("failed to install backup tool: %w", err)
	}
	if path == "" {
		// Already available (race with another call)
		return s.UseRestic(), nil
	}

	engine, engineErr := restic.NewEngine()
	if engineErr != nil {
		return false, fmt.Errorf("backup tool installed but failed to initialize: %w", engineErr)
	}

	s.resticMu.Lock()
	s.resticEngine = engine
	s.resticMu.Unlock()

	return true, nil
}

func (s *BackupService) SetServerSecret(secret string) {
	s.serverSecret = secret
}

func (s *BackupService) DeriveRepoPassword(appID string) string {
	return restic.DeriveRepoPassword(s.serverSecret, appID)
}

func (s *BackupService) SetEncryptionKey(key string) {
	s.encryptionKey = key
}

func (s *BackupService) UseRestic() bool {
	s.resticMu.RLock()
	defer s.resticMu.RUnlock()
	return s.resticEngine != nil
}

func (s *BackupService) BackupApp(ctx context.Context, appID string, opts BackupOptions) (*BackupResult, error) {
	startTime := time.Now()
	result := &BackupResult{}

	log.Printf("BackupApp: starting backup for app %s", appID)

	if !s.UseRestic() {
		result.Error = fmt.Errorf("backups require restic — install restic or enable auto-provision to create backups")
		return result, result.Error
	}

	var appPath, appStatus string
	err := s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", appID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found (id=%s): %w", appID, err)
		log.Printf("BackupApp: app not found (id=%s): %v", appID, err)
		return result, result.Error
	}
	log.Printf("BackupApp: found app at path %s with status %s", appPath, appStatus)

	if opts.StopBeforeBackup && appStatus == "running" {
		log.Printf("Stopping app %s for backup", appID)
		if err := s.runtime.ComposeStop(ctx, appPath); err != nil {
			result.Error = fmt.Errorf("failed to stop app: %w", err)
			return result, result.Error
		}
		defer func() {
			log.Printf("Restarting app %s after backup", appID)
			_ = s.runtime.ComposeUp(ctx, appPath)
		}()
	}

	if err := s.runPreBackupHook(ctx, appID, appPath); err != nil {
		log.Printf("BackupApp: pre-backup hook failed for %s: %v (continuing)", appID, err)
	}

	backupID := uuid.New().String()

	backup, err := s.backupWithRestic(ctx, appID, appPath, backupID)
	if err != nil {
		result.Error = err
		return result, result.Error
	}

	result.Backup = backup
	result.Duration = time.Since(startTime)
	log.Printf("Restic backup created for %s: snapshot %s in %v", appID, backup.SnapshotID, result.Duration)

	return result, nil
}

func (s *BackupService) backupWithRestic(ctx context.Context, appID, appPath, backupID string) (*Backup, error) {
	repo, repoID, err := s.getOrCreateRepoForApp(ctx, appID)
	if err != nil {
		return nil, fmt.Errorf("restic repo setup: %w", err)
	}

	if err := s.resticEngine.EnsureLocalRepo(ctx, *repo); err != nil {
		return nil, fmt.Errorf("restic repo init: %w", err)
	}

	summary, err := s.resticEngine.Backup(ctx, *repo, []string{appPath}, []string{appID, "libreserv"}, nil)
	if err != nil {
		return nil, fmt.Errorf("restic backup: %w", err)
	}

	backup := &Backup{
		ID:         backupID,
		AppID:      appID,
		Type:       BackupTypeApp,
		Path:       repo.Path,
		Size:       summary.TotalBytes,
		DataAdded:  summary.DataAdded,
		CreatedAt:  time.Now(),
		Format:     BackupFormatRestic,
		SnapshotID: summary.SnapshotID,
		RepoID:     repoID,
	}

	_, err = s.db.Exec(`
		INSERT INTO backups (id, app_id, type, path, size, data_added, created_at, format, snapshot_id, repo_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, backup.ID, backup.AppID, string(backup.Type), backup.Path, backup.Size, backup.DataAdded, backup.CreatedAt, string(backup.Format), backup.SnapshotID, backup.RepoID)

	if err != nil {
		return nil, fmt.Errorf("save restic backup record: %w", err)
	}

	return backup, nil
}

func (s *BackupService) ListBackups(ctx context.Context, appID string) ([]Backup, error) {
	var query string
	var args []interface{}

	if appID != "" {
		query = `SELECT b.id, b.app_id, b.type, b.path, b.size, b.created_at, b.checksum, COALESCE(b.source, 'local'), COALESCE(b.format, 'restic'), COALESCE(b.snapshot_id, ''), COALESCE(b.repo_id, ''), COALESCE(b.data_added, 0) FROM backups b WHERE b.app_id = ? ORDER BY b.created_at DESC`
		args = []interface{}{appID}
	} else {
		query = `SELECT b.id, b.app_id, b.type, b.path, b.size, b.created_at, b.checksum, COALESCE(b.source, 'local'), COALESCE(b.format, 'restic'), COALESCE(b.snapshot_id, ''), COALESCE(b.repo_id, ''), COALESCE(b.data_added, 0) FROM backups b LEFT JOIN apps a ON b.app_id = a.id ORDER BY b.created_at DESC`
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
		var backupType, source, format, snapshotID, repoID string
		var checksum, appID sql.NullString
		if err := rows.Scan(&b.ID, &appID, &backupType, &b.Path, &b.Size, &b.CreatedAt, &checksum, &source, &format, &snapshotID, &repoID, &b.DataAdded); err != nil {
			continue
		}
		if appID.Valid {
			b.AppID = appID.String
		}
		b.Type = BackupType(backupType)
		b.Source = source
		b.Format = BackupFormat(format)
		b.SnapshotID = snapshotID
		b.RepoID = repoID
		if checksum.Valid {
			b.Checksum = checksum.String
		}
		backups = append(backups, b)
	}

	return backups, nil
}

func (s *BackupService) GetBackup(ctx context.Context, backupID string) (*Backup, error) {
	var b Backup
	var backupType, source, format, snapshotID, repoID string
	var checksum, appID sql.NullString

	err := s.db.QueryRow(`
		SELECT id, app_id, type, path, size, created_at, checksum, COALESCE(source, 'local'), COALESCE(format, 'restic'), COALESCE(snapshot_id, ''), COALESCE(repo_id, ''), COALESCE(data_added, 0)
		FROM backups WHERE id = ?
	`, backupID).Scan(&b.ID, &appID, &backupType, &b.Path, &b.Size, &b.CreatedAt, &checksum, &source, &format, &snapshotID, &repoID, &b.DataAdded)

	if err != nil {
		return nil, fmt.Errorf("backup not found: %w", err)
	}

	if appID.Valid {
		b.AppID = appID.String
	}

	b.Type = BackupType(backupType)
	b.Source = source
	b.Format = BackupFormat(format)
	b.SnapshotID = snapshotID
	b.RepoID = repoID
	if checksum.Valid {
		b.Checksum = checksum.String
	}
	return &b, nil
}

func (s *BackupService) DeleteBackup(ctx context.Context, backupID string) error {
	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		return err
	}

	if backup.Format == BackupFormatRestic && s.UseRestic() && backup.SnapshotID != "" {
		repo, _, repoErr := s.getRepoForApp(ctx, backup.AppID)
		if repoErr == nil {
			if forgetErr := s.forgetSnapshot(ctx, *repo, backup.SnapshotID); forgetErr != nil {
				log.Printf("DeleteBackup: restic forget failed for snapshot %s: %v", backup.SnapshotID, forgetErr)
			}
		}
	}

	_, err = s.db.Exec("DELETE FROM backups WHERE id = ?", backupID)
	if err != nil {
		return fmt.Errorf("failed to delete backup record: %w", err)
	}

	log.Printf("Backup deleted: %s", backupID)
	return nil
}

func (s *BackupService) forgetSnapshot(ctx context.Context, repo restic.RepoConfig, snapshotID string) error {
	return s.resticEngine.ForgetSnapshot(ctx, repo, snapshotID)
}

func (s *BackupService) CleanupOldBackups(ctx context.Context, appID string, retention int) error {
	backups, err := s.ListBackups(ctx, appID)
	if err != nil {
		return err
	}

	if len(backups) <= retention {
		return nil
	}

	for i := retention; i < len(backups); i++ {
		if err := s.DeleteBackup(ctx, backups[i].ID); err != nil {
			log.Printf("Failed to delete old backup %s: %v", backups[i].ID, err)
		}
	}

	return nil
}

func (s *BackupService) BackupDatabase(ctx context.Context) (*DatabaseBackup, error) {
	backupDir := filepath.Join(s.basePath, "database")
	if err := os.MkdirAll(backupDir, 0750); err != nil {
		return nil, fmt.Errorf("failed to create backup directory: %w", err)
	}

	backupID := uuid.New().String()
	timestamp := time.Now().Format("20060102-150405")
	backupPath := filepath.Join(backupDir, fmt.Sprintf("libreserv-%s.db.gz", timestamp))

	tempPath := backupPath + ".tmp"

	if !safePathRegexp.MatchString(tempPath) {
		return nil, fmt.Errorf("invalid characters in backup path")
	}

	_, err := s.db.Exec(fmt.Sprintf("VACUUM INTO '%s'", tempPath))
	if err != nil {
		return nil, fmt.Errorf("database backup failed: %w", err)
	}

	if err := compressFile(tempPath, backupPath); err != nil {
		_ = os.Remove(tempPath)
		return nil, fmt.Errorf("compression failed: %w", err)
	}
	_ = os.Remove(tempPath)

	fileInfo, err := os.Stat(backupPath)
	if err != nil {
		return nil, err
	}

	checksum, err := fileChecksum(backupPath)
	if err != nil {
		checksum = ""
	}

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

	if s.UseRestic() {
		if err := s.backupDatabaseWithRestic(ctx, backupPath); err != nil {
			log.Printf("Warning: restic database backup failed: %v", err)
		}
	}

	return backup, nil
}

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

func (s *BackupService) GetRepository(ctx context.Context, repoID string) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
	SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
	FROM backup_repositories WHERE id = ?
	`, repoID).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("backup repository not found: %w", err)
	}
	return &repo, nil
}

func (s *BackupService) ListRepositories(ctx context.Context) ([]BackupRepository, error) {
	rows, err := s.db.Query(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query backup repositories: %w", err)
	}
	defer rows.Close()

	var repos []BackupRepository
	for rows.Next() {
		var repo BackupRepository
		if err := rows.Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt); err != nil {
			continue
		}
		repos = append(repos, repo)
	}
	return repos, nil
}

func (s *BackupService) GetRepositoryForApp(ctx context.Context, appID string) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories WHERE app_id = ? LIMIT 1
	`, appID).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("no repository configured for app %s: %w", appID, err)
	}
	return &repo, nil
}

// GetDefaultRepository returns the first non-system repo with no app assignment,
// which serves as the fallback for apps without an explicit repo.
func (s *BackupService) GetDefaultRepository(ctx context.Context) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories WHERE app_id IS NULL AND COALESCE(is_system, 0) = 0
		ORDER BY created_at DESC LIMIT 1
	`).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("no default repository configured: %w", err)
	}
	return &repo, nil
}

func (s *BackupService) DeleteRepository(ctx context.Context, repoID string) error {
	_, err := s.db.Exec("DELETE FROM backup_repositories WHERE id = ?", repoID)
	if err != nil {
		return fmt.Errorf("failed to delete backup repository: %w", err)
	}
	log.Printf("Backup repository deleted: %s", repoID)
	return nil
}

func (s *BackupService) TestRepository(ctx context.Context, repoConfig restic.RepoConfig) error {
	if s.resticEngine == nil {
		return fmt.Errorf("restic engine not available")
	}
	return s.resticEngine.Check(ctx, repoConfig)
}

func (s *BackupService) GetRepoStats(ctx context.Context, repoID string) (map[string]interface{}, error) {
	if s.resticEngine == nil {
		return nil, fmt.Errorf("restic engine not available")
	}
	repo, err := s.GetRepository(ctx, repoID)
	if err != nil {
		return nil, fmt.Errorf("repository not found: %w", err)
	}
	repoConfig := s.buildRepoConfigFromRepository(repo)
	return s.resticEngine.Stats(ctx, *repoConfig)
}

// GetRepositoryRecoveryKey decrypts and returns the recovery key (password)
// for a given backup repository. This is the key needed to restore backups
// from this repository on a new server.
func (s *BackupService) GetRepositoryRecoveryKey(ctx context.Context, repoID string) (string, error) {
	repo, err := s.GetRepository(ctx, repoID)
	if err != nil {
		return "", fmt.Errorf("repository not found: %w", err)
	}

	password := repo.Password
	if s.encryptionKey != "" && password != "" {
		decPass, decErr := decryptAESGCM(password, s.encryptionKey)
		if decErr != nil {
			return "", fmt.Errorf("could not decrypt recovery key: %w", decErr)
		}
		password = decPass
	}

	return password, nil
}

// --- Internal helpers ---

func (s *BackupService) getOrCreateRepoForApp(ctx context.Context, appID string) (*restic.RepoConfig, string, error) {
	existing, err := s.GetRepositoryForApp(ctx, appID)
	if err == nil && existing != nil {
		return s.buildRepoConfigFromRepository(existing), existing.ID, nil
	}

	defaultRepo, defErr := s.GetDefaultRepository(ctx)
	if defErr == nil && defaultRepo != nil {
		return s.buildRepoConfigFromRepository(defaultRepo), defaultRepo.ID, nil
	}

	repoID := uuid.New().String()
	repoType := "local"
	repoPath := restic.BuildRepoPath(repoType, s.basePath, appID)
	password := restic.DeriveRepoPassword(s.serverSecret, appID)

	repo := &BackupRepository{
		ID:        repoID,
		AppID:     appID,
		RepoType:  repoType,
		RepoPath:  repoPath,
		Password:  password,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.CreateRepository(ctx, repo); err != nil {
		return nil, "", err
	}

	return s.buildRepoConfigFromRepository(repo), repoID, nil
}

func (s *BackupService) getRepoForApp(ctx context.Context, appID string) (*restic.RepoConfig, string, error) {
	repo, err := s.GetRepositoryForApp(ctx, appID)
	if err != nil {
		return nil, "", err
	}
	return s.buildRepoConfigFromRepository(repo), repo.ID, nil
}

func (s *BackupService) getRepoByBackup(ctx context.Context, backup *Backup) (*restic.RepoConfig, error) {
	if backup.RepoID != "" {
		repo, err := s.GetRepository(ctx, backup.RepoID)
		if err != nil {
			return nil, fmt.Errorf("repository %s not found: %w", backup.RepoID, err)
		}
		return s.buildRepoConfigFromRepository(repo), nil
	}

	if backup.AppID != "" {
		repo, err := s.GetRepositoryForApp(ctx, backup.AppID)
		if err != nil {
			defaultRepo, defErr := s.GetDefaultRepository(ctx)
			if defErr != nil {
				return nil, fmt.Errorf("no repository for app %s and no default: %w", backup.AppID, defErr)
			}
			return s.buildRepoConfigFromRepository(defaultRepo), nil
		}
		return s.buildRepoConfigFromRepository(repo), nil
	}

	return nil, fmt.Errorf("cannot determine restic repository for backup %s", backup.ID)
}

func (s *BackupService) buildRepoConfigFromRepository(repo *BackupRepository) *restic.RepoConfig {
	env := map[string]string{}
	rawCreds := repo.Credentials

	if s.encryptionKey != "" && rawCreds != "" {
		if decCreds, err := decryptAESGCM(rawCreds, s.encryptionKey); err == nil {
			rawCreds = decCreds
		} else {
			log.Printf("Warning: failed to decrypt repo credentials for %s: %v", repo.ID, err)
		}
	}

	if rawCreds != "" {
		var creds map[string]string
		if json.Unmarshal([]byte(rawCreds), &creds) == nil {
			env = creds
		}
	}

	password := repo.Password
	if s.encryptionKey != "" && password != "" {
		if decPass, err := decryptAESGCM(password, s.encryptionKey); err == nil {
			password = decPass
		} else {
			log.Printf("Warning: failed to decrypt repo password for %s: %v", repo.ID, err)
		}
	}

	return &restic.RepoConfig{
		Type:              repo.RepoType,
		Path:              repo.RepoPath,
		Password:          password,
		Env:               env,
		LimitUploadKbps:   repo.LimitUploadKbps,
		LimitDownloadKbps: repo.LimitDownloadKbps,
	}
}

func (s *BackupService) runPreBackupHook(ctx context.Context, appID, appPath string) error {
	hookPath := filepath.Join(appPath, "scripts", "system-backup")
	if _, err := os.Stat(hookPath); err != nil {
		return nil
	}

	log.Printf("Running pre-backup hook for app %s", appID)
	cmd := exec.CommandContext(ctx, hookPath)
	cmd.Dir = appPath
	cmd.Env = append(os.Environ(),
		"LIBRESERV_APP_ID="+appID,
		"LIBRESERV_APP_PATH="+appPath,
		"LIBRESERV_BACKUP_HOOK=true",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("backup hook failed: %w\noutput: %s", err, string(output))
	}
	return nil
}

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

var safePathRegexp = regexp.MustCompile(`^[a-zA-Z0-9._/\-]+$`)

// isSafeTarPath checks that a tar entry path does not escape the intended
// parent directory. It rejects absolute paths, path traversal (..), and
// paths that — after cleaning — resolve outside the parent.
//
// NOTE: This assumes the host OS uses '/' as its path separator (Linux/macOS).
// Tar archives always store paths with forward slashes per the POSIX spec, and
// filepath.IsAbs / filepath.Separator are OS-dependent. On a Windows host the
// '/'-separated tar entry would need normalisation first. LibreServ targets
// Linux only, so this is not an issue in practice.
func isSafeTarPath(parent, relPath string) bool {
	// Reject absolute paths
	if filepath.IsAbs(relPath) {
		return false
	}
	// Reject path traversal components.
	// We split on both '/' (tar entry separator) and filepath.Separator (OS)
	// so that '..' is caught regardless of platform mismatch.
	for _, part := range strings.FieldsFunc(relPath, func(r rune) bool {
		return r == '/' || r == os.PathSeparator
	}) {
		if part == ".." {
			return false
		}
	}
	// Verify the cleaned, joined path still falls under parent
	joined := filepath.Join(parent, relPath)
	if !strings.HasPrefix(joined, parent+string(filepath.Separator)) && joined != parent {
		return false
	}
	return true
}

// createTarGzFromDir creates a tar.gz archive of a directory into the provided writer.
// It validates that every archive entry path remains within srcDir to prevent
// path traversal attacks (e.g. symlinks pointing outside the source tree).
func createTarGzFromDir(srcDir string, w io.Writer) error {
	gw := gzip.NewWriter(w)
	defer gw.Close()

	tw := tar.NewWriter(gw)
	defer tw.Close()

	// Resolve srcDir to an absolute path for consistent prefix checking
	absSrcDir, err := filepath.Abs(srcDir)
	if err != nil {
		return fmt.Errorf("resolve source dir: %w", err)
	}

	return filepath.Walk(absSrcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Resolve symlinks to ensure we don't archive paths outside srcDir
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return fmt.Errorf("read symlink %s: %w", path, err)
			}
			// Resolve the symlink target relative to its containing directory
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(path), target)
			}
			absTarget, err := filepath.Abs(filepath.Clean(target))
			if err != nil {
				return fmt.Errorf("resolve symlink target: %w", err)
			}
			if !strings.HasPrefix(absTarget, absSrcDir+string(filepath.Separator)) && absTarget != absSrcDir {
				slog.Warn("Skipping tar entry: symlink escapes source directory", "path", path, "target", absTarget)
				return nil
			}
		}

		relPath, err := filepath.Rel(absSrcDir, path)
		if err != nil {
			return fmt.Errorf("relative path for %s: %w", path, err)
		}

		// Verify the relative path is safe (no traversal)
		if !isSafeTarPath(absSrcDir, relPath) {
			slog.Warn("Skipping tar entry: path traversal detected", "path", path, "relPath", relPath)
			return nil
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return fmt.Errorf("tar header for %s: %w", path, err)
		}

		header.Name = relPath

		if err := tw.WriteHeader(header); err != nil {
			return fmt.Errorf("write header: %w", err)
		}

		if !info.IsDir() {
			f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return err
			}
			defer f.Close()
			if _, err := io.Copy(tw, f); err != nil {
				return fmt.Errorf("copy %s: %w", path, err)
			}
		}

		return nil
	})
}
