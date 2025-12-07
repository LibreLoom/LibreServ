package storage

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
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

// BackupApp creates a backup of an app's data
func (s *BackupService) BackupApp(ctx context.Context, appID string, opts BackupOptions) (*BackupResult, error) {
	startTime := time.Now()
	result := &BackupResult{}

	// Get app info from database
	var appPath, appStatus string
	err := s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", appID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found: %w", err)
		return result, result.Error
	}

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
			s.docker.ComposeUp(ctx, appPath)
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
		INSERT INTO backups (id, app_id, type, path, size, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, backup.ID, backup.AppID, string(backup.Type), backup.Path, backup.Size, backup.CreatedAt)
	
	if err != nil {
		// Clean up the backup file
		os.Remove(backupPath)
		result.Error = fmt.Errorf("failed to save backup record: %w", err)
		return result, result.Error
	}

	result.Backup = backup
	result.Duration = time.Since(startTime)
	
	log.Printf("Backup created for %s: %s (%d bytes) in %v", appID, backupPath, size, result.Duration)
	
	return result, nil
}

// createTarball creates a compressed tarball of a directory
func (s *BackupService) createTarball(srcPath, destPath string, opts BackupOptions) (string, int64, error) {
	// Create the destination file
	file, err := os.Create(destPath)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()

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
	err = filepath.Walk(srcPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip logs if not included
		if !opts.IncludeLogs && filepath.Base(path) == "logs" && info.IsDir() {
			return filepath.SkipDir
		}

		// Create tar header
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}

		// Update the header name to be relative to srcPath
		relPath, err := filepath.Rel(srcPath, path)
		if err != nil {
			return err
		}
		header.Name = relPath

		// Write header
		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}

		// If it's a regular file, write its contents
		if !info.IsDir() {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			defer file.Close()

			if _, err := io.Copy(tarWriter, file); err != nil {
				return err
			}
		}

		return nil
	})

	if err != nil {
		return "", 0, err
	}

	// Close writers to flush
	tarWriter.Close()
	if opts.Compress {
		writer.Close()
	}

	// Get file size
	fileInfo, err := os.Stat(destPath)
	if err != nil {
		return "", 0, err
	}

	checksum := hex.EncodeToString(hash.Sum(nil))
	return checksum, fileInfo.Size(), nil
}

// ListBackups returns all backups, optionally filtered by app ID
func (s *BackupService) ListBackups(ctx context.Context, appID string) ([]Backup, error) {
	var query string
	var args []interface{}

	if appID != "" {
		query = `SELECT id, app_id, type, path, size, created_at FROM backups WHERE app_id = ? ORDER BY created_at DESC`
		args = []interface{}{appID}
	} else {
		query = `SELECT id, app_id, type, path, size, created_at FROM backups ORDER BY created_at DESC`
	}

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query backups: %w", err)
	}
	defer rows.Close()

	var backups []Backup
	for rows.Next() {
		var b Backup
		var backupType string
		if err := rows.Scan(&b.ID, &b.AppID, &backupType, &b.Path, &b.Size, &b.CreatedAt); err != nil {
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
		SELECT id, app_id, type, path, size, created_at 
		FROM backups WHERE id = ?
	`, backupID).Scan(&b.ID, &b.AppID, &backupType, &b.Path, &b.Size, &b.CreatedAt)
	
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
	_, err := s.db.Exec(fmt.Sprintf("VACUUM INTO '%s'", tempPath))
	if err != nil {
		return nil, fmt.Errorf("database backup failed: %w", err)
	}

	// Compress the backup
	if err := compressFile(tempPath, backupPath); err != nil {
		os.Remove(tempPath)
		return nil, fmt.Errorf("compression failed: %w", err)
	}
	os.Remove(tempPath)

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
		os.Remove(backupPath)
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
	defer src.Close()

	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer dest.Close()

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
	defer file.Close()

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
