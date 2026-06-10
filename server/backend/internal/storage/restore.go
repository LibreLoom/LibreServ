package storage

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func (s *BackupService) RestoreApp(ctx context.Context, backupID string, targetAppID string, opts RestoreOptions) (*RestoreResult, error) {
	startTime := time.Now()
	result := &RestoreResult{BackupID: backupID}

	log.Printf("RestoreApp: starting restore for backup %s", backupID)

	if !s.UseRestic() {
		result.Error = fmt.Errorf("restoring backups requires restic — install restic or enable auto-provision")
		return result, result.Error
	}

	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		result.Error = fmt.Errorf("backup not found: %w", err)
		log.Printf("RestoreApp: backup not found: %v", err)
		return result, result.Error
	}

	if backup.Format != BackupFormatRestic || backup.SnapshotID == "" {
		result.Error = fmt.Errorf("backup %s is not a restic snapshot and cannot be restored", backupID)
		return result, result.Error
	}

	if targetAppID == "" {
		targetAppID = backup.AppID
	}
	if targetAppID == "" {
		result.Error = fmt.Errorf("no target app specified — select an app to restore to")
		return result, result.Error
	}

	log.Printf("RestoreApp: found backup for app %s, restoring to app %s (format=%s)", backup.AppID, targetAppID, backup.Format)

	var appPath, appStatus string
	err = s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", targetAppID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found (id=%s): %w", targetAppID, err)
		log.Printf("RestoreApp: app not found (id=%s): %v", targetAppID, err)
		return result, result.Error
	}

	if opts.StopBeforeRestore && appStatus == "running" {
		log.Printf("Stopping app %s for restore", targetAppID)
		stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := s.runtime.ComposeStop(stopCtx, appPath); err != nil {
			cancel()
			result.Error = fmt.Errorf("failed to stop app %s before restore: %w", targetAppID, err)
			log.Printf("RestoreApp: failed to stop app %s: %v", targetAppID, err)
			return result, result.Error
		}
		log.Printf("App %s stopped successfully", targetAppID)
	}

	if err := s.runPreRestoreHook(ctx, targetAppID, appPath); err != nil {
		log.Printf("RestoreApp: pre-restore hook failed for %s: %v (continuing)", targetAppID, err)
	}

	return s.restoreWithRestic(ctx, backup, targetAppID, appPath, opts, result, startTime)
}

func (s *BackupService) restoreWithRestic(ctx context.Context, backup *Backup, targetAppID, appPath string, opts RestoreOptions, result *RestoreResult, startTime time.Time) (*RestoreResult, error) {
	repo, err := s.getRepoByBackup(ctx, backup)
	if err != nil {
		result.Error = err
		return result, result.Error
	}

	currentBackupPath := appPath + ".pre-restore-" + time.Now().Format("20060102-150405")
	log.Printf("Creating pre-restore backup: renaming %s to %s", appPath, currentBackupPath)
	if err := os.Rename(appPath, currentBackupPath); err != nil {
		result.Error = fmt.Errorf("failed to backup current app state at %s: %w", appPath, err)
		return result, result.Error
	}
	defer func() {
		if result.Error == nil {
			log.Printf("Cleaning up pre-restore backup %s", currentBackupPath)
			_ = os.RemoveAll(currentBackupPath)
		} else {
			log.Printf("Restore failed, rolling back from %s", currentBackupPath)
			_ = os.RemoveAll(appPath)
			_ = os.Rename(currentBackupPath, appPath)
		}
	}()

	tmpRestoreDir := filepath.Join(s.basePath, "full-restore", backup.ID)
	if err := os.MkdirAll(tmpRestoreDir, 0750); err != nil {
		result.Error = fmt.Errorf("create temp restore dir: %w", err)
		return result, result.Error
	}
	defer os.RemoveAll(tmpRestoreDir)

	if err := s.resticEngine.Restore(ctx, *repo, backup.SnapshotID, tmpRestoreDir, nil); err != nil {
		result.Error = fmt.Errorf("restic restore failed: %w", err)
		return result, result.Error
	}

	if err := os.MkdirAll(appPath, 0750); err != nil {
		result.Error = fmt.Errorf("failed to create app directory: %w", err)
		return result, result.Error
	}

	entries, err := os.ReadDir(tmpRestoreDir)
	if err != nil {
		result.Error = fmt.Errorf("read restore output: %w", err)
		return result, result.Error
	}

	restoredAppDir, findErr := findRestoredAppDir(tmpRestoreDir, appPath)
	if findErr != nil {
		result.Error = fmt.Errorf("find restored app dir: %w", findErr)
		return result, result.Error
	}
	if restoredAppDir != "" {
		log.Printf("restoreWithRestic: found restored app dir at %s", restoredAppDir)
		innerEntries, innerErr := os.ReadDir(restoredAppDir)
		if innerErr != nil {
			result.Error = fmt.Errorf("read restored app dir: %w", innerErr)
			return result, result.Error
		}
		for _, entry := range innerEntries {
			src := filepath.Join(restoredAppDir, entry.Name())
			dst := filepath.Join(appPath, entry.Name())
			if err := os.Rename(src, dst); err != nil {
				if moveDirContents(src, dst) != nil {
					result.Error = fmt.Errorf("move restored content: %w", err)
					return result, result.Error
				}
			}
		}
	} else {
		for _, entry := range entries {
			src := filepath.Join(tmpRestoreDir, entry.Name())
			dst := filepath.Join(appPath, entry.Name())
			if err := os.Rename(src, dst); err != nil {
				if moveDirContents(src, dst) != nil {
					result.Error = fmt.Errorf("move restored content: %w", err)
					return result, result.Error
				}
			}
		}
	}

	if backup.AppID != "" && targetAppID != "" && backup.AppID != targetAppID {
		log.Printf("RestoreApp: rewriting instance ID %s -> %s in config files", backup.AppID, targetAppID)
		if err := rewriteInstanceID(appPath, backup.AppID, targetAppID); err != nil {
			result.Error = fmt.Errorf("failed to rewrite instance ID: %w", err)
			return result, result.Error
		}
	}

	if opts.RestartAfterRestore {
		log.Printf("Starting app %s after restore", targetAppID)
		startCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := s.runtime.ComposeUp(startCtx, appPath); err != nil {
			log.Printf("Warning: failed to start app %s after restore: %v", targetAppID, err)
			_, _ = s.db.Exec("UPDATE apps SET status = 'stopped', updated_at = ? WHERE id = ?", time.Now(), targetAppID)
		} else {
			_, _ = s.db.Exec("UPDATE apps SET status = 'running', updated_at = ? WHERE id = ?", time.Now(), targetAppID)
		}
	}

	result.Duration = time.Since(startTime)
	log.Printf("Restic restore completed for %s from snapshot %s in %v", backup.AppID, backup.SnapshotID, result.Duration)

	if backup.AppID != "" && targetAppID != "" && backup.AppID != targetAppID {
		if _, err := s.db.Exec("UPDATE backups SET app_id = ? WHERE id = ?", targetAppID, backup.ID); err != nil {
			log.Printf("Warning: failed to update backup app_id: %v", err)
		}
	}

	return result, nil
}

func findRestoredAppDir(root, appPath string) (string, error) {
	appBase := filepath.Base(appPath)
	parentBase := filepath.Base(filepath.Dir(appPath))

	candidate := filepath.Join(root, appPath)
	if info, err := os.Stat(candidate); err == nil && info.IsDir() {
		return candidate, nil
	}

	var result string
	var walkErr error
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			walkErr = err
			slog.Warn("findRestoredAppDir: walk error", "path", path, "error", err)
			return nil
		}
		if result != "" {
			return filepath.SkipAll
		}
		if info.IsDir() && filepath.Base(path) == appBase {
			dir := filepath.Dir(path)
			if filepath.Base(dir) == parentBase || parentBase == "." || parentBase == "" {
				result = path
				return filepath.SkipAll
			}
		}
		return nil
	})
	if result == "" && walkErr != nil {
		return "", fmt.Errorf("findRestoredAppDir: walk error: %w", walkErr)
	}
	return result, nil
}

func moveDirContents(srcDir, dstDir string) error {
	if err := os.MkdirAll(dstDir, 0750); err != nil {
		return err
	}
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		src := filepath.Join(srcDir, entry.Name())
		dst := filepath.Join(dstDir, entry.Name())
		if err := os.Rename(src, dst); err != nil {
			if entry.IsDir() {
				if moveErr := moveDirContents(src, dst); moveErr != nil {
					return fmt.Errorf("move dir contents %s -> %s: %w", src, dst, moveErr)
				}
			} else {
				if copyErr := copyFile(src, dst); copyErr != nil {
					return fmt.Errorf("move %s -> %s: %w", src, dst, copyErr)
				}
			}
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode())
	if err != nil {
		return err
	}

	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(dst)
		return closeErr
	}

	os.Remove(src)
	return nil
}

func (s *BackupService) RestoreDatabase(ctx context.Context, backupID string, opts DatabaseRestoreOptions) error {
	var backup DatabaseBackup
	err := s.db.QueryRow(`
		SELECT id, path, size, created_at, checksum 
		FROM database_backups WHERE id = ?
	`, backupID).Scan(&backup.ID, &backup.Path, &backup.Size, &backup.CreatedAt, &backup.Checksum)

	if err != nil {
		return fmt.Errorf("database backup not found: %w", err)
	}

	if _, err := os.Stat(backup.Path); os.IsNotExist(err) {
		return fmt.Errorf("backup file not found: %s", backup.Path)
	}

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

	dbPath := s.db.Path()
	if dbPath == "" {
		return fmt.Errorf("database path is unknown")
	}
	restoreTmp := fmt.Sprintf("%s.restore-%s.tmp", dbPath, time.Now().Format("20060102-150405"))

	if err := decompressGzipFile(backup.Path, restoreTmp, 0600); err != nil {
		return fmt.Errorf("failed to decompress database backup: %w", err)
	}
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

func (s *BackupService) CleanupOldDatabaseBackups(ctx context.Context, retention int) error {
	backups, err := s.ListDatabaseBackups(ctx)
	if err != nil {
		return err
	}

	if len(backups) <= retention {
		return nil
	}

	for i := retention; i < len(backups); i++ {
		if err := os.Remove(backups[i].Path); err != nil && !os.IsNotExist(err) {
			log.Printf("Failed to delete old database backup file %s: %v", backups[i].Path, err)
		}

		_, _ = s.db.Exec("DELETE FROM database_backups WHERE id = ?", backups[i].ID)
	}

	return nil
}

func (s *BackupService) DeleteDatabaseBackupRecord(ctx context.Context, id string) error {
	_, err := s.db.Exec("DELETE FROM database_backups WHERE id = ?", id)
	return err
}

func (s *BackupService) CleanupGhostDatabaseBackups(ctx context.Context) error {
	backups, err := s.ListDatabaseBackups(ctx)
	if err != nil {
		return err
	}

	for _, b := range backups {
		if _, err := os.Stat(b.Path); os.IsNotExist(err) {
			log.Printf("Cleaning up ghost database backup record: %s (file missing)", b.ID)
			if err := s.DeleteDatabaseBackupRecord(ctx, b.ID); err != nil {
				log.Printf("warning: failed to delete ghost backup record %s: %v", b.ID, err)
			}
		}
	}
	return nil
}

func (s *BackupService) runPreRestoreHook(ctx context.Context, appID, appPath string) error {
	hookPath := filepath.Join(appPath, "scripts", "system-restore")
	if _, err := os.Stat(hookPath); err != nil {
		return nil
	}

	log.Printf("Running pre-restore hook for app %s", appID)
	cmd := exec.CommandContext(ctx, hookPath)
	cmd.Dir = appPath
	cmd.Env = append(os.Environ(),
		"LIBRESERV_APP_ID="+appID,
		"LIBRESERV_APP_PATH="+appPath,
		"LIBRESERV_RESTORE_HOOK=true",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restore hook failed: %w\noutput: %s", err, string(output))
	}
	return nil
}

func rewriteInstanceID(appPath, oldInstanceID, newInstanceID string) error {
	if oldInstanceID == "" || newInstanceID == "" || oldInstanceID == newInstanceID {
		return nil
	}

	log.Printf("rewriteInstanceID: replacing %s -> %s in %s", oldInstanceID, newInstanceID, appPath)

	libreservPath := filepath.Join(appPath, ".libreserv.yaml")
	if _, err := os.Stat(libreservPath); err == nil {
		if err := rewriteFileInstanceID(libreservPath, oldInstanceID, newInstanceID); err != nil {
			return fmt.Errorf("failed to rewrite .libreserv.yaml: %w", err)
		}
		log.Printf("rewriteInstanceID: rewritten .libreserv.yaml")
	}

	composePath := filepath.Join(appPath, "docker-compose.yml")
	if _, err := os.Stat(composePath); err == nil {
		if err := rewriteFileInstanceID(composePath, oldInstanceID, newInstanceID); err != nil {
			return fmt.Errorf("failed to rewrite docker-compose.yml: %w", err)
		}
		log.Printf("rewriteInstanceID: rewritten docker-compose.yml")
	}

	appComposeDir := filepath.Join(appPath, "app-compose")
	if entries, err := os.ReadDir(appComposeDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && (strings.HasSuffix(entry.Name(), ".yml") || strings.HasSuffix(entry.Name(), ".yaml")) {
				fullPath := filepath.Join(appComposeDir, entry.Name())
				if err := rewriteFileInstanceID(fullPath, oldInstanceID, newInstanceID); err != nil {
					log.Printf("rewriteInstanceID: warning: failed to rewrite %s: %v", entry.Name(), err)
				} else {
					log.Printf("rewriteInstanceID: rewritten %s", entry.Name())
				}
			}
		}
	}

	return nil
}

func rewriteFileInstanceID(filePath, oldID, newID string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}

	content := string(data)
	if !strings.Contains(content, oldID) {
		log.Printf("rewriteFileInstanceID: %s does not contain old instance ID, skipping", filePath)
		return nil
	}

	newContent := strings.ReplaceAll(content, oldID, newID)

	oldPathPrefix := filepath.Join("apps", oldID)
	newPathPrefix := filepath.Join("apps", newID)
	newContent = strings.ReplaceAll(newContent, oldPathPrefix, newPathPrefix)

	if newContent == content {
		return nil
	}

	if err := os.WriteFile(filePath, []byte(newContent), 0640); err != nil {
		return err
	}

	log.Printf("rewriteFileInstanceID: replaced instance ID in %s", filePath)
	return nil
}
