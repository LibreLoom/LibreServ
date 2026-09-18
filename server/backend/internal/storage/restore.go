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
