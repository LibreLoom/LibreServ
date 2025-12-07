package storage

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RestoreApp restores an app from a backup
func (s *BackupService) RestoreApp(ctx context.Context, backupID string, opts RestoreOptions) (*RestoreResult, error) {
	startTime := time.Now()
	result := &RestoreResult{BackupID: backupID}

	// Get backup info
	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		result.Error = fmt.Errorf("backup not found: %w", err)
		return result, result.Error
	}

	// Verify backup file exists
	if _, err := os.Stat(backup.Path); os.IsNotExist(err) {
		result.Error = fmt.Errorf("backup file not found: %s", backup.Path)
		return result, result.Error
	}

	// Verify checksum if requested
	if opts.VerifyChecksum && backup.Checksum != "" {
		checksum, err := fileChecksum(backup.Path)
		if err != nil {
			result.Error = fmt.Errorf("failed to verify checksum: %w", err)
			return result, result.Error
		}
		if checksum != backup.Checksum {
			result.Error = fmt.Errorf("checksum mismatch: backup may be corrupted")
			return result, result.Error
		}
	}

	// Get app info
	var appPath, appStatus string
	err = s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", backup.AppID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found: %w", err)
		return result, result.Error
	}

	// Stop app if required and running
	if opts.StopBeforeRestore && appStatus == "running" {
		log.Printf("Stopping app %s for restore", backup.AppID)
		if err := s.docker.ComposeStop(ctx, appPath); err != nil {
			result.Error = fmt.Errorf("failed to stop app: %w", err)
			return result, result.Error
		}
	}

	// Create backup of current state before restoring
	currentBackupPath := appPath + ".pre-restore-" + time.Now().Format("20060102-150405")
	if err := os.Rename(appPath, currentBackupPath); err != nil {
		// If rename fails, try to continue anyway
		log.Printf("Warning: could not backup current state: %v", err)
	} else {
		defer func() {
			// Clean up the pre-restore backup if restore succeeded
			if result.Error == nil {
				os.RemoveAll(currentBackupPath)
			} else {
				// Restore failed, rollback
				os.RemoveAll(appPath)
				os.Rename(currentBackupPath, appPath)
			}
		}()
	}

	// Create app directory
	if err := os.MkdirAll(appPath, 0755); err != nil {
		result.Error = fmt.Errorf("failed to create app directory: %w", err)
		return result, result.Error
	}

	// Extract the backup
	if err := s.extractTarball(backup.Path, appPath); err != nil {
		result.Error = fmt.Errorf("failed to extract backup: %w", err)
		return result, result.Error
	}

	// Restart app if requested
	if opts.RestartAfterRestore {
		log.Printf("Starting app %s after restore", backup.AppID)
		if err := s.docker.ComposeUp(ctx, appPath); err != nil {
			result.Error = fmt.Errorf("failed to start app after restore: %w", err)
			return result, result.Error
		}
		
		// Update app status
		s.db.Exec("UPDATE apps SET status = 'running', updated_at = ? WHERE id = ?", time.Now(), backup.AppID)
	}

	result.Duration = time.Since(startTime)
	log.Printf("Restore completed for %s from backup %s in %v", backup.AppID, backupID, result.Duration)
	
	return result, nil
}

// extractTarball extracts a tarball (possibly gzipped) to a directory
func (s *BackupService) extractTarball(tarPath, destPath string) error {
	file, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer file.Close()

	var reader io.Reader = file

	// Check if gzipped
	if strings.HasSuffix(tarPath, ".gz") || strings.HasSuffix(tarPath, ".tgz") {
		gzReader, err := gzip.NewReader(file)
		if err != nil {
			return fmt.Errorf("failed to create gzip reader: %w", err)
		}
		defer gzReader.Close()
		reader = gzReader
	}

	tarReader := tar.NewReader(reader)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("error reading tar: %w", err)
		}

		// Sanitize the path to prevent directory traversal
		targetPath := filepath.Join(destPath, header.Name)
		if !strings.HasPrefix(targetPath, filepath.Clean(destPath)+string(os.PathSeparator)) {
			return fmt.Errorf("invalid file path in archive: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, os.FileMode(header.Mode)); err != nil {
				return fmt.Errorf("failed to create directory %s: %w", targetPath, err)
			}

		case tar.TypeReg:
			// Ensure parent directory exists
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				return fmt.Errorf("failed to create parent directory: %w", err)
			}

			outFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode))
			if err != nil {
				return fmt.Errorf("failed to create file %s: %w", targetPath, err)
			}

			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return fmt.Errorf("failed to write file %s: %w", targetPath, err)
			}
			outFile.Close()

		case tar.TypeSymlink:
			if err := os.Symlink(header.Linkname, targetPath); err != nil {
				return fmt.Errorf("failed to create symlink %s: %w", targetPath, err)
			}

		case tar.TypeLink:
			linkPath := filepath.Join(destPath, header.Linkname)
			if err := os.Link(linkPath, targetPath); err != nil {
				return fmt.Errorf("failed to create hard link %s: %w", targetPath, err)
			}
		}

		// Set modification time
		if err := os.Chtimes(targetPath, header.AccessTime, header.ModTime); err != nil {
			// Non-fatal error, just log it
			log.Printf("Warning: could not set modification time for %s: %v", targetPath, err)
		}
	}

	return nil
}

// RestoreDatabase restores the LibreServ database from a backup
func (s *BackupService) RestoreDatabase(ctx context.Context, backupID string) error {
	// Get backup info
	var backup DatabaseBackup
	err := s.db.QueryRow(`
		SELECT id, path, size, created_at, checksum 
		FROM database_backups WHERE id = ?
	`, backupID).Scan(&backup.ID, &backup.Path, &backup.Size, &backup.CreatedAt, &backup.Checksum)
	
	if err != nil {
		return fmt.Errorf("database backup not found: %w", err)
	}

	// Verify backup file exists
	if _, err := os.Stat(backup.Path); os.IsNotExist(err) {
		return fmt.Errorf("backup file not found: %s", backup.Path)
	}

	// This is a complex operation that requires:
	// 1. Closing all database connections
	// 2. Decompressing the backup
	// 3. Replacing the database file
	// 4. Reopening the database
	
	// For safety, this should be done by a separate process or restart
	// Here we just prepare the restore file
	
	log.Printf("Database restore from %s requested - requires service restart", backup.Path)
	return fmt.Errorf("database restore requires service restart - backup prepared at %s", backup.Path)
}

// ListDatabaseBackups returns all database backups
func (s *BackupService) ListDatabaseBackups(ctx context.Context) ([]DatabaseBackup, error) {
	rows, err := s.db.Query(`
		SELECT id, path, size, created_at, checksum 
		FROM database_backups 
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query database backups: %w", err)
	}
	defer rows.Close()

	var backups []DatabaseBackup
	for rows.Next() {
		var b DatabaseBackup
		if err := rows.Scan(&b.ID, &b.Path, &b.Size, &b.CreatedAt, &b.Checksum); err != nil {
			continue
		}
		backups = append(backups, b)
	}

	return backups, nil
}

// CleanupOldDatabaseBackups removes old database backups
func (s *BackupService) CleanupOldDatabaseBackups(ctx context.Context, retention int) error {
	backups, err := s.ListDatabaseBackups(ctx)
	if err != nil {
		return err
	}

	if len(backups) <= retention {
		return nil
	}

	// Delete older backups
	for i := retention; i < len(backups); i++ {
		// Delete file
		if err := os.Remove(backups[i].Path); err != nil && !os.IsNotExist(err) {
			log.Printf("Failed to delete old database backup file %s: %v", backups[i].Path, err)
		}
		
		// Delete record
		s.db.Exec("DELETE FROM database_backups WHERE id = ?", backups[i].ID)
	}

	return nil
}
