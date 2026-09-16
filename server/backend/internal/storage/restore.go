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

	slog.Info("RestoreApp: found backup", "source_app_id", backup.AppID, "target_app_id", targetAppID, "format", backup.Format)

	var appPath, appStatus string
	err = s.db.QueryRow("SELECT path, status FROM apps WHERE id = ?", targetAppID).Scan(&appPath, &appStatus)
	if err != nil {
		result.Error = fmt.Errorf("app not found (id=%s): %w", targetAppID, err)
		slog.Warn("RestoreApp: app not found", "app_id", targetAppID, "error", err)
		return result, result.Error
	}

	if opts.StopBeforeRestore && appStatus == "running" {
		slog.Info("RestoreApp: stopping app for restore", "app_id", targetAppID)
		stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := s.runtime.ComposeStop(stopCtx, appPath); err != nil {
			cancel()
			result.Error = fmt.Errorf("failed to stop app %s before restore: %w", targetAppID, err)
			slog.Warn("RestoreApp: failed to stop app", "app_id", targetAppID, "error", err)
			return result, result.Error
		}
		slog.Info("RestoreApp: app stopped successfully", "app_id", targetAppID)
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
	slog.Info("restoreWithRestic: creating pre-restore backup", "app_path", appPath, "backup_path", currentBackupPath)
	if err := os.Rename(appPath, currentBackupPath); err != nil {
		result.Error = fmt.Errorf("failed to backup current app state at %s: %w", appPath, err)
		return result, result.Error
	}
	defer func() {
		if result.Error == nil {
			slog.Info("restoreWithRestic: cleaning up pre-restore backup", "backup_path", currentBackupPath)
			if err := os.RemoveAll(currentBackupPath); err != nil {
				slog.Warn("restoreWithRestic: failed to remove pre-restore backup", "backup_path", currentBackupPath, "error", err)
			}
			return
		}
		// A failed rollback leaves the app directory half-restored or missing
		// entirely. Reporting only the original restore error would hide that,
		// so the rollback failure is folded into result.Error.
		slog.Warn("restoreWithRestic: restore failed, rolling back", "backup_path", currentBackupPath)
		if err := os.RemoveAll(appPath); err != nil {
			slog.Warn("restoreWithRestic: rollback failed to clear app directory", "app_path", appPath, "error", err)
			result.Error = fmt.Errorf("%w (rollback also failed: could not clear %s: %v)", result.Error, appPath, err)
			return
		}
		if err := os.Rename(currentBackupPath, appPath); err != nil {
			slog.Warn("restoreWithRestic: rollback failed to restore previous app state", "backup_path", currentBackupPath, "error", err)
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
		slog.Info("RestoreApp: rewriting instance ID in config files", "old_app_id", backup.AppID, "new_app_id", targetAppID)
		if err := rewriteInstanceID(appPath, backup.AppID, targetAppID); err != nil {
			result.Error = fmt.Errorf("failed to rewrite instance ID: %w", err)
			return result, result.Error
		}
	}

	if opts.RestartAfterRestore {
		slog.Info("RestoreApp: starting app after restore", "app_id", targetAppID)
		startCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := s.runtime.ComposeUp(startCtx, appPath); err != nil {
			slog.Warn("RestoreApp: failed to start app after restore", "app_id", targetAppID, "error", err)
			s.setAppStatus(targetAppID, "stopped")
		} else {
			s.setAppStatus(targetAppID, "running")
		}
	}

	result.Duration = time.Since(startTime)
	slog.Info("restoreWithRestic: restic restore completed", "app_id", backup.AppID, "snapshot_id", backup.SnapshotID, "duration", result.Duration)

	if backup.AppID != "" && targetAppID != "" && backup.AppID != targetAppID {
		if _, err := s.db.Exec("UPDATE backups SET app_id = ? WHERE id = ?", targetAppID, backup.ID); err != nil {
			slog.Warn("RestoreApp: failed to update backup app_id", "error", err)
		}
	}

	return result, nil
}

