package handlers

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

// BackupHandlers handles backup-related API endpoints
type BackupHandlers struct {
	backupService *storage.BackupService
}

// NewBackupHandlers creates new backup handlers
func NewBackupHandlers(backupService *storage.BackupService) *BackupHandlers {
	return &BackupHandlers{
		backupService: backupService,
	}
}

// ListBackups returns all backups
// GET /api/backups?app_id=optional
func (h *BackupHandlers) ListBackups(w http.ResponseWriter, r *http.Request) {
	appID := r.URL.Query().Get("app_id")

	backups, err := h.backupService.ListBackups(r.Context(), appID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
		"count":   len(backups),
	})
}

// GetBackup returns a specific backup
// GET /api/backups/{backupID}
func (h *BackupHandlers) GetBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	backup, err := h.backupService.GetBackup(r.Context(), backupID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	JSON(w, http.StatusOK, backup)
}

// CreateBackupRequest is the request body for creating a backup
type CreateBackupRequest struct {
	AppID            string `json:"app_id"`
	StopBeforeBackup bool   `json:"stop_before_backup"`
	Compress         bool   `json:"compress"`
	IncludeConfig    bool   `json:"include_config"`
	IncludeLogs      bool   `json:"include_logs"`
}

// CreateBackup creates a new backup
// POST /api/backups
func (h *BackupHandlers) CreateBackup(w http.ResponseWriter, r *http.Request) {
	var req CreateBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.AppID == "" {
		JSONError(w, http.StatusBadRequest, "app_id is required")
		return
	}

	opts := storage.BackupOptions{
		StopBeforeBackup: req.StopBeforeBackup,
		Compress:         req.Compress,
		IncludeConfig:    req.IncludeConfig,
		IncludeLogs:      req.IncludeLogs,
	}

	// Default compress to true
	if !req.Compress {
		opts.Compress = true
	}

	result, err := h.backupService.BackupApp(r.Context(), req.AppID, opts)
	if err != nil {
		errMsg := err.Error()
		if result != nil && result.Error != nil {
			errMsg = result.Error.Error()
		}
		JSONError(w, http.StatusInternalServerError, errMsg)
		return
	}

	JSON(w, http.StatusCreated, map[string]interface{}{
		"backup":   result.Backup,
		"duration": result.Duration.String(),
	})
}

// RestoreBackupRequest is the request body for restoring a backup
type RestoreBackupRequest struct {
	StopBeforeRestore   bool `json:"stop_before_restore"`
	RestartAfterRestore bool `json:"restart_after_restore"`
	VerifyChecksum      bool `json:"verify_checksum"`
}

// RestoreBackup restores from a backup
// POST /api/backups/{backupID}/restore
func (h *BackupHandlers) RestoreBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	var req RestoreBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Use defaults if no body provided
		req = RestoreBackupRequest{
			StopBeforeRestore:   true,
			RestartAfterRestore: true,
			VerifyChecksum:      true,
		}
	}

	opts := storage.RestoreOptions{
		StopBeforeRestore:   req.StopBeforeRestore,
		RestartAfterRestore: req.RestartAfterRestore,
		VerifyChecksum:      req.VerifyChecksum,
	}

	result, err := h.backupService.RestoreApp(r.Context(), backupID, opts)
	if err != nil {
		errMsg := err.Error()
		if result != nil && result.Error != nil {
			errMsg = result.Error.Error()
		}
		JSONError(w, http.StatusInternalServerError, errMsg)
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backup_id": result.BackupID,
		"duration":  result.Duration.String(),
		"status":    "restored",
	})
}

// DeleteBackup deletes a backup
// DELETE /api/backups/{backupID}
func (h *BackupHandlers) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	if err := h.backupService.DeleteBackup(r.Context(), backupID); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":  "deleted",
		"message": "Backup deleted successfully",
	})
}

// CreateDatabaseBackup creates a backup of the LibreServ database
// POST /api/backups/database
func (h *BackupHandlers) CreateDatabaseBackup(w http.ResponseWriter, r *http.Request) {
	backup, err := h.backupService.BackupDatabase(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusCreated, backup)
}

// ListDatabaseBackups returns all database backups
// GET /api/backups/database
func (h *BackupHandlers) ListDatabaseBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := h.backupService.ListDatabaseBackups(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
		"count":   len(backups),
	})
}

// RestoreDatabaseBackupRequest is the request body for restoring a database backup.
type RestoreDatabaseBackupRequest struct {
	VerifyChecksum bool `json:"verify_checksum"`
}

// RestoreDatabaseBackup restores the LibreServ database from a database backup.
// POST /api/v1/backups/database/{backupID}/restore
func (h *BackupHandlers) RestoreDatabaseBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	req := RestoreDatabaseBackupRequest{VerifyChecksum: true}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	opts := storage.DatabaseRestoreOptions{VerifyChecksum: req.VerifyChecksum}

	if err := h.backupService.RestoreDatabase(r.Context(), backupID, opts); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backup_id": backupID,
		"status":    "restored",
	})
}
