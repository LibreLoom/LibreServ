package storage

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *BackupService) RestoreApp(ctx context.Context, backupID string, targetAppID string, opts RestoreOptions) (*RestoreResult, error) {
	startTime := time.Now()
	result := &RestoreResult{BackupID: backupID}

	slog.Info("RestoreApp: starting restore", "backup_id", backupID)

	if !s.UseRestic() {
		result.Error = fmt.Errorf("restoring backups requires restic — install restic or enable auto-provision")
		return result, result.Error
	}

	backup, err := s.GetBackup(ctx, backupID)
	if err != nil {
		result.Error = fmt.Errorf("backup not found: %w", err)
		slog.Warn("RestoreApp: backup not found", "error", err)
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

	slog.Info("RestoreApp: found backup", "backup_app_id", backup.AppID, "target_app_id", targetAppID, "format", backup.Format)

	var appPath, appStatus string
	err = s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", targetAppID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found (id=%s): %w", targetAppID, err)
		slog.Warn("RestoreApp: app not found", "app_id", targetAppID, "error", err)
		return result, result.Error
	}

	if opts.StopBeforeRestore && appStatus == "running" {
		slog.Info("Stopping app for restore", "app_id", targetAppID)
		stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := s.runtime.ComposeStop(stopCtx, appPath); err != nil {
			cancel()
			result.Error = fmt.Errorf("failed to stop app %s before restore: %w", targetAppID, err)
			slog.Warn("RestoreApp: failed to stop app", "app_id", targetAppID, "error", err)
			return result, result.Error
		}
		slog.Info("App stopped successfully", "app_id", targetAppID)
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
	slog.Info("Creating pre-restore backup", "from", appPath, "to", currentBackupPath)
	if err := os.Rename(appPath, currentBackupPath); err != nil {
		result.Error = fmt.Errorf("failed to backup current app state at %s: %w", appPath, err)
		return result, result.Error
	}
	defer func() {
		if result.Error == nil {
			slog.Info("Cleaning up pre-restore backup", "path", currentBackupPath)
			if err := os.RemoveAll(currentBackupPath); err != nil {
				slog.Warn("failed to remove pre-restore backup", "path", currentBackupPath, "error", err)
			}
			return
		}
		// A failed rollback leaves the app directory half-restored or missing
		// entirely. Reporting only the original restore error would hide that,
		// so the rollback failure is folded into result.Error.
		slog.Warn("Restore failed, rolling back", "path", currentBackupPath)
		if err := os.RemoveAll(appPath); err != nil {
			slog.Warn("Rollback: failed to clear app directory", "path", appPath, "error", err)
			result.Error = fmt.Errorf("%w (rollback also failed: could not clear %s: %v)", result.Error, appPath, err)
			return
		}
		if err := os.Rename(currentBackupPath, appPath); err != nil {
			slog.Warn("Rollback: failed to restore previous app state", "path", currentBackupPath, "error", err)
			result.Error = fmt.Errorf("%w (rollback also failed: previous app state left at %s: %v)", result.Error, currentBackupPath, err)
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

	// SECURITY FIX (audit #4): validate the restored tree for symlink escapes
	// and path-traversal before moving anything to the live app directory.
	// Restic can materialize symlinks inside tmpRestoreDir; a crafted backup
	// could contain `data -> /etc` and cause os.Rename to overwrite host files.
	if err := validateRestoredTree(tmpRestoreDir); err != nil {
		result.Error = fmt.Errorf("restored tree validation failed: %w", err)
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
		slog.Info("restoreWithRestic: found restored app dir", "path", restoredAppDir)
		innerEntries, innerErr := os.ReadDir(restoredAppDir)
		if innerErr != nil {
			result.Error = fmt.Errorf("read restored app dir: %w", innerErr)
			return result, result.Error
		}
		for _, entry := range innerEntries {
			src := filepath.Join(restoredAppDir, entry.Name())
			dst := filepath.Join(appPath, entry.Name())
			if err := secureMove(src, dst, appPath); err != nil {
				result.Error = fmt.Errorf("move restored content: %w", err)
				return result, result.Error
			}
		}
	} else {
		for _, entry := range entries {
			src := filepath.Join(tmpRestoreDir, entry.Name())
			dst := filepath.Join(appPath, entry.Name())
			if err := secureMove(src, dst, appPath); err != nil {
				result.Error = fmt.Errorf("move restored content: %w", err)
				return result, result.Error
			}
		}
	}

	if backup.AppID != "" && targetAppID != "" && backup.AppID != targetAppID {
		slog.Info("RestoreApp: rewriting instance ID in config files", "from", backup.AppID, "to", targetAppID)
		if err := rewriteInstanceID(appPath, backup.AppID, targetAppID); err != nil {
			result.Error = fmt.Errorf("failed to rewrite instance ID: %w", err)
			return result, result.Error
		}
	}

	if opts.RestartAfterRestore {
		slog.Info("Starting app after restore", "app_id", targetAppID)
		startCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := s.runtime.ComposeUp(startCtx, appPath); err != nil {
			slog.Warn("failed to start app after restore", "app_id", targetAppID, "error", err)
			s.setAppStatus(targetAppID, "stopped")
		} else {
			s.setAppStatus(targetAppID, "running")
		}
	}

	result.Duration = time.Since(startTime)
	slog.Info("Restic restore completed", "app_id", backup.AppID, "snapshot_id", backup.SnapshotID, "duration", result.Duration)

	if backup.AppID != "" && targetAppID != "" && backup.AppID != targetAppID {
		if _, err := s.db.Exec("UPDATE backups SET app_id = ? WHERE id = ?", targetAppID, backup.ID); err != nil {
			slog.Warn("failed to update backup app_id", "error", err)
		}
	}

	return result, nil
}

// setAppStatus records an app status after a restore. The restore itself has
// already succeeded or failed by this point, so a write failure must not change
// the outcome — but a stale status in the UI needs a trace.
func (s *BackupService) setAppStatus(appID, status string) {
	if _, err := s.db.Exec("UPDATE apps SET status = ?, updated_at = ? WHERE id = ?", status, time.Now(), appID); err != nil {
		slog.Warn("failed to set app status", "app_id", appID, "status", status, "error", err)
	}
}

func findRestoredAppDir(root, appPath string) (string, error) {
	appBase := filepath.Base(appPath)
	parentBase := filepath.Base(filepath.Dir(appPath))

	candidate := filepath.Join(root, appPath)
	if info, err := os.Lstat(candidate); err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		return candidate, nil
	}

	var result string
	var walkErr error
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			walkErr = err
			slog.Warn("findRestoredAppDir: walk error", "path", path, "error", err)
			return nil
		}
		if result != "" {
			return filepath.SkipAll
		}
		// Use Lstat semantics via Walk's info — but double-check symlink bit
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		cleanBase := filepath.Base(filepath.Clean(path))
		if info.IsDir() && cleanBase == appBase {
			dir := filepath.Dir(path)
			dirBase := filepath.Base(filepath.Clean(dir))
			if dirBase == parentBase || parentBase == "." || parentBase == "" {
				result = path
				return filepath.SkipAll
			}
		}
		return nil
	}); err != nil {
		return "", fmt.Errorf("findRestoredAppDir: walk %s: %w", root, err)
	}
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
		// Validate dst stays within intended parent before any filesystem write.
		if !isSafeRestoreDestination(dst, dstDir) {
			return fmt.Errorf("unsafe restore destination: %s", dst)
		}
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
	defer func() {
		if err := os.Remove(restoreTmp); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove temporary restore file", "path", restoreTmp, "error", err)
		}
	}()

	slog.Info("Restoring database from backup", "backup_id", backupID, "db_path", dbPath)
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
			slog.Warn("failed to scan database backup row", "error", err)
			continue
		}
		backups = append(backups, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate database backups: %w", err)
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
			slog.Warn("Failed to delete old database backup file", "path", backups[i].Path, "error", err)
		}

		if err := s.DeleteDatabaseBackupRecord(ctx, backups[i].ID); err != nil {
			slog.Warn("Failed to delete old database backup record", "id", backups[i].ID, "error", err)
		}
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
			slog.Warn("Cleaning up ghost database backup record", "id", b.ID, "reason", "file missing")
			if err := s.DeleteDatabaseBackupRecord(ctx, b.ID); err != nil {
				slog.Warn("failed to delete ghost backup record", "id", b.ID, "error", err)
			}
		}
	}
	return nil
}

// SECURITY FIX (audit #4): helpers to validate restored file trees and destinations.
func validateRestoredTree(root string) error {
	absRoot, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return err
	}
	var walkErr error
	err = filepath.Walk(absRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			walkErr = err
			return nil
		}
		// Reject ALL symlinks outright. Even an in-root link is a TOCTOU hazard:
		// a later os.Rename of a path through this link would follow it. The
		// escape-resolution logic below was removed because it was dead code —
		// every symlink reaches this rejection regardless of where it points.
		if info.Mode()&os.ModeSymlink != 0 {
			target, _ := os.Readlink(path)
			return fmt.Errorf("restored tree contains symlink (rejected): %s -> %s", path, target)
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if !isSafeTarPath(absRoot, rel) {
			return fmt.Errorf("path traversal in restored tree: %s", rel)
		}
		return nil
	})
	// The callback error comes first: it carries the symlink/traversal
	// rejection, which must not be masked by an unrelated stat failure.
	if err != nil {
		return err
	}
	return walkErr
}

func isSafeRestoreDestination(dst, allowedParent string) bool {
	absDst, err := filepath.Abs(filepath.Clean(dst))
	if err != nil {
		return false
	}
	absParent, err := filepath.Abs(filepath.Clean(allowedParent))
	if err != nil {
		return false
	}
	if absDst == absParent {
		return true
	}
	return strings.HasPrefix(absDst, absParent+string(filepath.Separator))
}

func secureMove(src, dst, allowedParent string) error {
	if !isSafeRestoreDestination(dst, allowedParent) {
		return fmt.Errorf("unsafe restore destination: %s", dst)
	}
	// Lstat src to reject symlink sources.
	if info, err := os.Lstat(src); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to move symlink: %s", src)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	return moveDirContents(src, dst)
}

func rewriteInstanceID(appPath, oldInstanceID, newInstanceID string) error {
	if oldInstanceID == "" || newInstanceID == "" || oldInstanceID == newInstanceID {
		return nil
	}

	slog.Info("rewriteInstanceID: replacing instance ID", "from", oldInstanceID, "to", newInstanceID, "path", appPath)

	libreservPath := filepath.Join(appPath, ".libreserv.yaml")
	if _, err := os.Stat(libreservPath); err == nil {
		if err := rewriteFileInstanceID(libreservPath, oldInstanceID, newInstanceID); err != nil {
			return fmt.Errorf("failed to rewrite .libreserv.yaml: %w", err)
		}
		slog.Info("rewriteInstanceID: rewritten .libreserv.yaml")
	}

	composePath := filepath.Join(appPath, "docker-compose.yml")
	if _, err := os.Stat(composePath); err == nil {
		if err := rewriteFileInstanceID(composePath, oldInstanceID, newInstanceID); err != nil {
			return fmt.Errorf("failed to rewrite docker-compose.yml: %w", err)
		}
		slog.Info("rewriteInstanceID: rewritten docker-compose.yml")
	}

	appComposeDir := filepath.Join(appPath, "app-compose")
	if entries, err := os.ReadDir(appComposeDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && (strings.HasSuffix(entry.Name(), ".yml") || strings.HasSuffix(entry.Name(), ".yaml")) {
				fullPath := filepath.Join(appComposeDir, entry.Name())
				if err := rewriteFileInstanceID(fullPath, oldInstanceID, newInstanceID); err != nil {
					slog.Warn("rewriteInstanceID: failed to rewrite file", "file", entry.Name(), "error", err)
				} else {
					slog.Info("rewriteInstanceID: rewritten file", "file", entry.Name())
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
		slog.Info("rewriteFileInstanceID: skipping file without old instance ID", "path", filePath)
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

	slog.Info("rewriteFileInstanceID: replaced instance ID", "path", filePath)
	return nil
}
