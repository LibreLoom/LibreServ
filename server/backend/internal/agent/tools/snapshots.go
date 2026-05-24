package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

func SnapshotTools(backupSvc *storage.BackupService) []*Tool {
	if backupSvc == nil {
		return nil
	}

	return []*Tool{
		{
			Name:        "snapshot_create",
			Description: "Create a backup snapshot of the current system state. Use this before making changes so they can be undone if something goes wrong.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"app_id": {"type": "string", "description": "The app to snapshot (optional — leave empty for a system-wide snapshot)"}
				}
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					AppID string `json:"app_id"`
				}
				_ = json.Unmarshal(args, &params)

				if !backupSvc.UseRestic() {
					return `{"status": "unavailable", "message": "Backup snapshots require restic, which is not set up yet. Your administrator can enable this in Settings → Backups."}`, nil
				}

				if params.AppID != "" {
					opts := storage.BackupOptions{}
					result, err := backupSvc.BackupApp(ctx, params.AppID, opts)
					if err != nil {
						return "", fmt.Errorf("unable to create snapshot: %w", err)
					}
					snapData := map[string]interface{}{
						"status":       "created",
						"app_id":       params.AppID,
						"backup_id":    "",
						"duration_sec": result.Duration.Seconds(),
					}
					if result.Backup != nil {
						snapData["backup_id"] = result.Backup.ID
						snapData["snapshot_id"] = result.Backup.SnapshotID
						snapData["size"] = result.Backup.Size
						snapData["created_at"] = result.Backup.CreatedAt.Format(time.RFC3339)
					}
					data, _ := json.MarshalIndent(snapData, "", "  ")
					return string(data), nil
				}

				backups, err := backupSvc.ListBackups(ctx, "")
				if err != nil {
					return "", fmt.Errorf("unable to check existing backups: %w", err)
				}
				result := map[string]interface{}{
					"status":       "snapshot_info",
					"existing":     len(backups),
					"restic_ready": true,
					"message":      "Provide an app_id to create a specific app snapshot. System-wide snapshots require specifying which app to back up.",
				}
				if len(backups) > 0 {
					result["latest_backup_id"] = backups[0].ID
					result["latest_backup_at"] = backups[0].CreatedAt
				}
				data, _ := json.MarshalIndent(result, "", "  ")
				return string(data), nil
			},
		},
		{
			Name:        "snapshot_list",
			Description: "List available backup snapshots. These are restore points the assistant can use to undo changes.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"app_id": {"type": "string", "description": "Filter to a specific app's snapshots (optional)"}
				}
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					AppID string `json:"app_id"`
				}
				_ = json.Unmarshal(args, &params)

				if !backupSvc.UseRestic() {
					return `{"snapshots": [], "message": "Backup snapshots require restic, which is not set up yet."}`, nil
				}

				backups, err := backupSvc.ListBackups(ctx, params.AppID)
				if err != nil {
					return "", fmt.Errorf("unable to list snapshots: %w", err)
				}

				type snapInfo struct {
					ID        string `json:"id"`
					AppID     string `json:"app_id"`
					CreatedAt string `json:"created_at"`
					Size      int64  `json:"size"`
				}
				var snaps []snapInfo
				for _, b := range backups {
					snaps = append(snaps, snapInfo{
						ID:        b.ID,
						AppID:     b.AppID,
						CreatedAt: b.CreatedAt.Format(time.RFC3339),
						Size:      b.Size,
					})
				}
				if snaps == nil {
					snaps = []snapInfo{}
				}
				data, _ := json.MarshalIndent(map[string]interface{}{
					"snapshots": snaps,
					"count":     len(snaps),
				}, "", "  ")
				return string(data), nil
			},
		},
		{
			Name:        "snapshot_restore",
			Description: "Restore an app from a backup snapshot. This undoes changes made after the snapshot was created. The app will be stopped, restored, and restarted.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"backup_id": {"type": "string", "description": "The backup ID to restore from (from snapshot_list)"},
					"app_id": {"type": "string", "description": "The app to restore (required if restoring to a different app than the backup)"}
				},
				"required": ["backup_id"]
			}`),
			IsResearch:         false,
			RequiresPermission: true,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					BackupID string `json:"backup_id"`
					AppID    string `json:"app_id"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				if params.BackupID == "" {
					return "", fmt.Errorf("backup_id is required")
				}

				opts := storage.RestoreOptions{
					StopBeforeRestore:   true,
					RestartAfterRestore: true,
					VerifyChecksum:      true,
				}

				result, err := backupSvc.RestoreApp(ctx, params.BackupID, params.AppID, opts)
				if err != nil {
					return "", fmt.Errorf("restore failed: %w", err)
				}

				resp := map[string]interface{}{
					"status":       "restored",
					"backup_id":    result.BackupID,
					"duration_sec": result.Duration.Seconds(),
				}
				data, _ := json.MarshalIndent(resp, "", "  ")
				return string(data), nil
			},
		},
	}
}
