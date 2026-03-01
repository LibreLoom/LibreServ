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

	log.Printf("RestoreApp: starting restore for backup %s", backupID)

	// Get backup info
	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		result.Error = fmt.Errorf("backup not found: %w", err)
		log.Printf("RestoreApp: backup not found: %v", err)
		return result, result.Error
	}
	log.Printf("RestoreApp: found backup for app %s at %s", backup.AppID, backup.Path)

	// Verify backup file exists
	if _, err := os.Stat(backup.Path); os.IsNotExist(err) {
		result.Error = fmt.Errorf("backup file not found: %s", backup.Path)
		return result, result.Error
	}

	// Verify checksum if requested or when available
	if (opts.VerifyChecksum || backup.Checksum != "") && backup.Checksum != "" {
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
		result.Error = fmt.Errorf("app not found (id=%s): %w", backup.AppID, err)
		log.Printf("RestoreApp: app not found (id=%s): %v", backup.AppID, err)
		return result, result.Error
	}
	log.Printf("RestoreApp: found app at path %s with status %s", appPath, appStatus)

	// Stop app if required and running
	if opts.StopBeforeRestore && appStatus == "running" {
		log.Printf("Stopping app %s for restore", backup.AppID)
		stopCtx, cancel := context.WithTimeout(ctx, 8*time.Second) // Increased timeout for 2-step stop
		defer cancel()
		if err := s.docker.ComposeStop(stopCtx, appPath); err != nil {
			log.Printf("Warning: failed to stop app %s: %v", backup.AppID, err)
			// Continue anyway - we'll try to force rename and restore
			log.Printf("Will attempt restore despite failed stop - data may be inconsistent")
		}
		// Give Docker a moment to release file locks
		time.Sleep(500 * time.Millisecond)
	}

	// Create backup of current state before restoring
	currentBackupPath := appPath + ".pre-restore-" + time.Now().Format("20060102-150405")
	log.Printf("RestoreApp: attempting to backup current state by renaming %s to %s", appPath, currentBackupPath)

	// Try multiple times to rename, files might be briefly locked
	var renameErr error
	for i := 0; i < 5; i++ { // Increased from 3 to 5 attempts
		renameErr = os.Rename(appPath, currentBackupPath)
		if renameErr == nil {
			log.Printf("RestoreApp: successfully backed up current state to %s", currentBackupPath)
			defer func() {
				// Clean up the pre-restore backup if restore succeeded
				if result.Error == nil {
					log.Printf("RestoreApp: cleaning up pre-restore backup %s", currentBackupPath)
					_ = os.RemoveAll(currentBackupPath)
				} else {
					// Restore failed, rollback
					log.Printf("RestoreApp: restore failed, rolling back from %s to %s", currentBackupPath, appPath)
					_ = os.RemoveAll(appPath)
					_ = os.Rename(currentBackupPath, appPath)
				}
			}()
			break
		}
		log.Printf("RestoreApp: rename attempt %d failed: %v", i+1, renameErr)
		// If rename fails with "device or resource busy", containers might still be running
		if strings.Contains(renameErr.Error(), "device or resource busy") ||
			strings.Contains(renameErr.Error(), "The process cannot access") {
			// Try to kill containers more aggressively
			log.Printf("RestoreApp: files busy, trying to force kill containers")
			forceCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			_ = s.docker.ComposeDown(forceCtx, appPath) // Try docker compose down
			cancel()
			time.Sleep(200 * time.Millisecond)
		}
		time.Sleep(300 * time.Millisecond) // Longer delay between attempts
	}

	if renameErr != nil {
		// If rename fails even after retries, fail the restore
		result.Error = fmt.Errorf("cannot backup current app state; directory may be in use: %w", renameErr)
		log.Printf("RestoreApp: failed to backup current state after 5 attempts: %v", renameErr)
		return result, result.Error
	}

	// Create app directory (if rename failed, directory already exists)
	if _, err := os.Stat(appPath); os.IsNotExist(err) {
		log.Printf("RestoreApp: creating app directory %s", appPath)
		if err := os.MkdirAll(appPath, 0755); err != nil {
			result.Error = fmt.Errorf("failed to create app directory: %w", err)
			return result, result.Error
		}
	} else {
		log.Printf("RestoreApp: app directory %s already exists", appPath)
	}

	// Extract the backup
	log.Printf("RestoreApp: extracting backup from %s to %s", backup.Path, appPath)
	if err := s.extractTarball(backup.Path, appPath); err != nil {
		result.Error = fmt.Errorf("failed to extract backup: %w", err)
		return result, result.Error
	}
	log.Printf("RestoreApp: backup extracted successfully")

	// Restart app if requested
	if opts.RestartAfterRestore {
		log.Printf("Starting app %s after restore", backup.AppID)
		startCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := s.docker.ComposeUp(startCtx, appPath); err != nil {
			log.Printf("Warning: failed to start app %s after restore: %v", backup.AppID, err)
			// Continue anyway - the data was restored
			// Update app status to stopped since we couldn't start it
			_, _ = s.db.Exec("UPDATE apps SET status = 'stopped', updated_at = ? WHERE id = ?", time.Now(), backup.AppID)
		} else {
			// Update app status to running
			_, _ = s.db.Exec("UPDATE apps SET status = 'running', updated_at = ? WHERE id = ?", time.Now(), backup.AppID)
		}
	}

	result.Duration = time.Since(startTime)
	log.Printf("Restore completed for %s from backup %s in %v", backup.AppID, backupID, result.Duration)

	return result, nil
}

// extractTarball extracts a tarball (possibly gzipped) to a directory
func (s *BackupService) extractTarball(tarPath, destPath string) error {
	log.Printf("extractTarball: opening %s (absolute path: %s)", tarPath, getAbsPath(tarPath))

	// Check if file exists
	if _, err := os.Stat(tarPath); err != nil {
		log.Printf("extractTarball: file stat error: %v", err)
		return fmt.Errorf("backup file not found: %w", err)
	}

	file, err := os.Open(tarPath)
	if err != nil {
		log.Printf("extractTarball: failed to open file: %v", err)
		return err
	}
	defer func() {
		_ = file.Close()
		log.Printf("extractTarball: file closed")
	}()

	fileInfo, _ := file.Stat()
	log.Printf("extractTarball: file size: %d bytes", fileInfo.Size())

	var reader io.Reader = file

	// Check if gzipped
	if strings.HasSuffix(tarPath, ".gz") || strings.HasSuffix(tarPath, ".tgz") {
		log.Printf("extractTarball: creating gzip reader")
		gzReader, err := gzip.NewReader(file)
		if err != nil {
			log.Printf("extractTarball: failed to create gzip reader: %v", err)
			return fmt.Errorf("failed to create gzip reader: %w", err)
		}
		defer func() {
			_ = gzReader.Close()
			log.Printf("extractTarball: gzip reader closed")
		}()
		reader = gzReader
	}

	tarReader := tar.NewReader(reader)
	fileCount := 0

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			log.Printf("extractTarball: extracted %d files", fileCount)
			break
		}
		if err != nil {
			log.Printf("extractTarball: error reading tar header (file %d): %v", fileCount, err)
			return fmt.Errorf("error reading tar: %w", err)
		}
		fileCount++

		if fileCount == 1 {
			log.Printf("extractTarball: first file: %s (type: %c)", header.Name, header.Typeflag)
		}

		// Sanitize the path to prevent directory traversal
		targetPath := filepath.Join(destPath, header.Name)
		cleanDest := filepath.Clean(destPath)
		if !strings.HasPrefix(targetPath, cleanDest+string(os.PathSeparator)) {
			log.Printf("extractTarball: invalid file path in archive: %s", header.Name)
			return fmt.Errorf("invalid file path in archive: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			log.Printf("extractTarball: creating directory %s", targetPath)
			if err := os.MkdirAll(targetPath, os.FileMode(header.Mode)); err != nil {
				log.Printf("extractTarball: failed to create directory %s: %v", targetPath, err)
				return fmt.Errorf("failed to create directory %s: %w", targetPath, err)
			}

		case tar.TypeReg:
			// Ensure parent directory exists
			parentDir := filepath.Dir(targetPath)
			if err := os.MkdirAll(parentDir, 0755); err != nil {
				log.Printf("extractTarball: failed to create parent directory %s: %v", parentDir, err)
				return fmt.Errorf("failed to create parent directory: %w", err)
			}

			log.Printf("extractTarball: extracting file %s (size: %d)", targetPath, header.Size)
			outFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode))
			if err != nil {
				log.Printf("extractTarball: failed to create file %s: %v", targetPath, err)
				return fmt.Errorf("failed to create file %s: %w", targetPath, err)
			}

			if _, err := io.Copy(outFile, tarReader); err != nil {
				_ = outFile.Close()
				log.Printf("extractTarball: failed to write file %s: %v", targetPath, err)
				return fmt.Errorf("failed to write file %s: %w", targetPath, err)
			}
			_ = outFile.Close()

		case tar.TypeSymlink, tar.TypeLink:
			// For safety, disallow link restoration to avoid path escapes.
			log.Printf("extractTarball: archive contains links which are not supported: %s", header.Name)
			return fmt.Errorf("archive contains links which are not supported for restore: %s", header.Name)
		}

		// Set modification time
		if err := os.Chtimes(targetPath, header.AccessTime, header.ModTime); err != nil {
			// Non-fatal error, just log it
			log.Printf("Warning: could not set modification time for %s: %v", targetPath, err)
		}
	}

	log.Printf("extractTarball: successfully extracted %d files", fileCount)
	return nil
}

func getAbsPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

// RestoreDatabase restores the LibreServ database from a backup
func (s *BackupService) RestoreDatabase(ctx context.Context, backupID string, opts DatabaseRestoreOptions) error {
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

	// Verify checksum.
	if opts.VerifyChecksum && backup.Checksum == "" {
		return fmt.Errorf("database backup has no checksum recorded; refusing to restore without integrity verification")
	}
	if backup.Checksum != "" && (opts.VerifyChecksum || backup.Checksum != "") {
		checksum, err := fileChecksum(backup.Path)
		if err != nil {
			return fmt.Errorf("failed to verify database backup checksum: %w", err)
		}
		if checksum != backup.Checksum {
			return fmt.Errorf("checksum mismatch: database backup may be corrupted")
		}
	}

	// Decompress into same directory as the live DB to make rename atomic.
	dbPath := s.db.Path()
	if dbPath == "" {
		return fmt.Errorf("database path is unknown")
	}
	restoreTmp := fmt.Sprintf("%s.restore-%s.tmp", dbPath, time.Now().Format("20060102-150405"))

	if err := decompressGzipFile(backup.Path, restoreTmp, 0600); err != nil {
		return fmt.Errorf("failed to decompress database backup: %w", err)
	}
	// If restore succeeds, ReplaceFile() will move restoreTmp into place; otherwise cleanup best-effort.
	defer func() { _ = os.Remove(restoreTmp) }()

	log.Printf("Restoring database from backup %s into %s", backupID, dbPath)
	if err := s.db.ReplaceFile(ctx, restoreTmp); err != nil {
		return fmt.Errorf("database restore failed: %w", err)
	}

	return nil
}

func decompressGzipFile(srcPath, destPath string, perm os.FileMode) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()

	gzr, err := gzip.NewReader(src)
	if err != nil {
		return err
	}
	defer func() { _ = gzr.Close() }()

	// Use O_EXCL to avoid accidentally clobbering an existing file.
	dst, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	defer func() { _ = dst.Close() }()

	if _, err := io.Copy(dst, gzr); err != nil {
		return err
	}
	return nil
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
	defer func() { _ = rows.Close() }()

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

		// Delete record - best effort, don't fail if this errors
		_, _ = s.db.Exec("DELETE FROM database_backups WHERE id = ?", backups[i].ID)
	}

	return nil
}
