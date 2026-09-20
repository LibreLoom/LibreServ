package storage

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
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
		slog.Info("BackupService: restic engine initialized (binary found)")
	} else {
		go func() {
			if _, provErr := restic.AutoProvision(); provErr != nil {
				slog.Warn("BackupService: restic auto-provision failed", "error", provErr)
				return
			}
			if engine, initErr := restic.NewEngine(); initErr == nil {
				svc.resticMu.Lock()
				svc.resticEngine = engine
				svc.resticMu.Unlock()
				slog.Info("BackupService: restic engine initialized (auto-provisioned)")
			}
		}()
		slog.Info("BackupService: restic not available, attempting auto-provision", "error", err)
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

	slog.Info("BackupApp: starting backup", "app_id", appID)

	if !s.UseRestic() {
		result.Error = fmt.Errorf("backups require restic — install restic or enable auto-provision to create backups")
		return result, result.Error
	}

	var appPath, appStatus string
	err := s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", appID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found (id=%s): %w", appID, err)
		slog.Warn("BackupApp: app not found", "app_id", appID, "error", err)
		return result, result.Error
	}
	slog.Info("BackupApp: found app", "path", appPath, "status", appStatus)

	if opts.StopBeforeBackup && appStatus == "running" {
		slog.Info("Stopping app for backup", "app_id", appID)
		if err := s.runtime.ComposeStop(ctx, appPath); err != nil {
			result.Error = fmt.Errorf("failed to stop app: %w", err)
			return result, result.Error
		}
		defer func() {
			slog.Info("Restarting app after backup", "app_id", appID)
			if err := s.runtime.ComposeUp(ctx, appPath); err != nil {
				// The app was running before the backup and is now down; the
				// backup result says nothing about that, so it must be logged.
				slog.Error("failed to restart app after backup, app is left stopped", "app_id", appID, "error", err)
			}
		}()
	}

	if err := s.runPreBackupHook(ctx, appID, appPath); err != nil {
		slog.Warn("BackupApp: pre-backup hook failed (continuing)", "app_id", appID, "error", err)
	}

	backupID := uuid.New().String()

	backup, err := s.backupWithRestic(ctx, appID, appPath, backupID)
	if err != nil {
		result.Error = err
		return result, result.Error
	}

	result.Backup = backup
	result.Duration = time.Since(startTime)
	slog.Info("Restic backup created", "app_id", appID, "snapshot_id", backup.SnapshotID, "duration", result.Duration)

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
			slog.Warn("failed to close rows", "error", cerr)
		}
	}()

	var backups []Backup
	for rows.Next() {
		var b Backup
		var backupType, source, format, snapshotID, repoID string
		var checksum, appID sql.NullString
		if err := rows.Scan(&b.ID, &appID, &backupType, &b.Path, &b.Size, &b.CreatedAt, &checksum, &source, &format, &snapshotID, &repoID, &b.DataAdded); err != nil {
			slog.Warn("failed to scan backup row", "error", err)
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
	if err := rows.Err(); err != nil {
		// A short list here reads as "these backups do not exist", which is the
		// worst possible lie for a restore UI.
		return nil, fmt.Errorf("failed to iterate backups: %w", err)
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
				slog.Warn("DeleteBackup: restic forget failed", "snapshot_id", backup.SnapshotID, "error", forgetErr)
			}
		}
	}

	_, err = s.db.Exec("DELETE FROM backups WHERE id = ?", backupID)
	if err != nil {
		return fmt.Errorf("failed to delete backup record: %w", err)
	}

	slog.Info("Backup deleted", "backup_id", backupID)
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
			slog.Warn("Failed to delete old backup", "backup_id", backups[i].ID, "error", err)
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
		removeTemp(tempPath)
		return nil, fmt.Errorf("compression failed: %w", err)
	}
	removeTemp(tempPath)

	fileInfo, err := os.Stat(backupPath)
	if err != nil {
		return nil, err
	}

	checksum, err := fileChecksum(backupPath)
	if err != nil {
		// An empty checksum makes later verified restores refuse this backup,
		// so record why it is missing.
		slog.Warn("failed to checksum database backup, restore verification will be unavailable", "path", backupPath, "error", err)
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
		removeTemp(backupPath)
		return nil, fmt.Errorf("failed to save backup record: %w", err)
	}

	slog.Info("Database backup created", "path", backupPath, "bytes", backup.Size)

	if s.UseRestic() {
		if err := s.backupDatabaseWithRestic(ctx, backupPath); err != nil {
			slog.Warn("restic database backup failed", "error", err)
		}
	}

	return backup, nil
}
