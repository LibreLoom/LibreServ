package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

type CloudStatusProvider interface {
	GetBackupCloudStatus(ctx context.Context, backupID string) (map[string]interface{}, error)
}

// BackupHandlers handles backup-related API endpoints
type BackupHandlers struct {
	backupService *storage.BackupService
	cloudService  CloudStatusProvider
}

// NewBackupHandlers creates new backup handlers
func NewBackupHandlers(backupService *storage.BackupService, cloudService CloudStatusProvider) *BackupHandlers {
	return &BackupHandlers{
		backupService: backupService,
		cloudService:  cloudService,
	}
}

// ListBackups returns all backups
// GET /api/backups?app_id=optional
func (h *BackupHandlers) ListBackups(w http.ResponseWriter, r *http.Request) {
	appID := r.URL.Query().Get("app_id")

	backups, err := h.backupService.ListBackups(r.Context(), appID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list backups")
		return
	}

	for i := range backups {
		if h.cloudService != nil {
			status, err := h.cloudService.GetBackupCloudStatus(r.Context(), backups[i].ID)
			if err == nil {
				backups[i].CloudStatus = status
			}
		}
		if backups[i].CloudStatus == nil {
			backups[i].CloudStatus = map[string]interface{}{"has_cloud_copy": false}
		}
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
		JSONError(w, http.StatusNotFound, "backup not found")
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
		errMsg := "backup failed"
		if result != nil && result.Error != nil {
			log.Printf("CreateBackup: failed for app %s: %s", req.AppID, result.Error)
		} else {
			log.Printf("CreateBackup: failed for app %s: %s", req.AppID, err)
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
	TargetAppID         string `json:"target_app_id,omitempty"`
	StopBeforeRestore   bool   `json:"stop_before_restore"`
	RestartAfterRestore bool   `json:"restart_after_restore"`
	VerifyChecksum      bool   `json:"verify_checksum"`
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

	result, err := h.backupService.RestoreApp(r.Context(), backupID, req.TargetAppID, opts)
	if err != nil {
		errMsg := "restore failed"
		if result != nil && result.Error != nil {
			log.Printf("RestoreBackup: failed for backup %s: %s", backupID, result.Error)
		} else {
			log.Printf("RestoreBackup: failed for backup %s: %s", backupID, err)
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
		JSONError(w, http.StatusInternalServerError, "failed to delete backup")
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
		JSONError(w, http.StatusInternalServerError, "failed to create database backup")
		return
	}

	JSON(w, http.StatusCreated, backup)
}

// ListDatabaseBackups returns all database backups
// GET /api/backups/database
func (h *BackupHandlers) ListDatabaseBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := h.backupService.ListDatabaseBackups(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list database backups")
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
		JSONError(w, http.StatusInternalServerError, "failed to restore database backup")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backup_id": backupID,
		"status":    "restored",
	})
}

// ListSchedules returns all backup schedules
// GET /api/v1/backups/schedules
func (h *BackupHandlers) ListSchedules(w http.ResponseWriter, r *http.Request) {
	schedules, err := h.backupService.ListSchedules(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list schedules")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"schedules": schedules,
		"count":     len(schedules),
	})
}

// GetSchedule returns a specific backup schedule
// GET /api/v1/backups/schedules/{scheduleID}
func (h *BackupHandlers) GetSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID := chi.URLParam(r, "scheduleID")
	if scheduleID == "" {
		JSONError(w, http.StatusBadRequest, "schedule ID required")
		return
	}

	schedule, err := h.backupService.GetSchedule(r.Context(), scheduleID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "schedule not found")
		return
	}

	JSON(w, http.StatusOK, schedule)
}

// CreateScheduleRequest is the request body for creating a backup schedule
type CreateScheduleRequest struct {
	AppID            string `json:"app_id"`
	Type             string `json:"type"`
	CronExpr         string `json:"cron_expr"`
	Enabled          bool   `json:"enabled"`
	StopBeforeBackup bool   `json:"stop_before_backup"`
	Compress         bool   `json:"compress"`
	IncludeConfig    bool   `json:"include_config"`
	IncludeLogs      bool   `json:"include_logs"`
	Retention        int    `json:"retention"`
}

// CreateSchedule creates a new backup schedule
// POST /api/v1/backups/schedules
func (h *BackupHandlers) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	var req CreateScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.CronExpr == "" {
		JSONError(w, http.StatusBadRequest, "cron_expr is required")
		return
	}

	if req.Type == "" {
		req.Type = "app"
	}

	if req.Retention == 0 {
		req.Retention = 7
	}

	schedule := &storage.BackupSchedule{
		ID:       uuid.New().String(),
		AppID:    req.AppID,
		Type:     storage.BackupType(req.Type),
		CronExpr: req.CronExpr,
		Enabled:  req.Enabled,
		Options: storage.BackupOptions{
			StopBeforeBackup: req.StopBeforeBackup,
			Compress:         req.Compress,
			IncludeConfig:    req.IncludeConfig,
			IncludeLogs:      req.IncludeLogs,
		},
		Retention: req.Retention,
		CreatedAt: time.Now(),
	}

	if err := h.backupService.CreateSchedule(r.Context(), schedule); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to create schedule")
		return
	}

	JSON(w, http.StatusCreated, schedule)
}

// UpdateScheduleRequest is the request body for updating a backup schedule
type UpdateScheduleRequest struct {
	CronExpr         string `json:"cron_expr,omitempty"`
	Enabled          *bool  `json:"enabled,omitempty"`
	StopBeforeBackup *bool  `json:"stop_before_backup,omitempty"`
	Compress         *bool  `json:"compress,omitempty"`
	IncludeConfig    *bool  `json:"include_config,omitempty"`
	IncludeLogs      *bool  `json:"include_logs,omitempty"`
	Retention        *int   `json:"retention,omitempty"`
}

// UpdateSchedule updates a backup schedule
// PUT /api/v1/backups/schedules/{scheduleID}
func (h *BackupHandlers) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID := chi.URLParam(r, "scheduleID")
	if scheduleID == "" {
		JSONError(w, http.StatusBadRequest, "schedule ID required")
		return
	}

	var req UpdateScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	schedule, err := h.backupService.GetSchedule(r.Context(), scheduleID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "schedule not found")
		return
	}

	if req.CronExpr != "" {
		schedule.CronExpr = req.CronExpr
	}
	if req.Enabled != nil {
		schedule.Enabled = *req.Enabled
	}
	if req.StopBeforeBackup != nil {
		schedule.Options.StopBeforeBackup = *req.StopBeforeBackup
	}
	if req.Compress != nil {
		schedule.Options.Compress = *req.Compress
	}
	if req.IncludeConfig != nil {
		schedule.Options.IncludeConfig = *req.IncludeConfig
	}
	if req.IncludeLogs != nil {
		schedule.Options.IncludeLogs = *req.IncludeLogs
	}
	if req.Retention != nil {
		schedule.Retention = *req.Retention
	}

	if err := h.backupService.UpdateSchedule(r.Context(), schedule); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to update schedule")
		return
	}

	JSON(w, http.StatusOK, schedule)
}

// DeleteSchedule deletes a backup schedule
// DELETE /api/v1/backups/schedules/{scheduleID}
func (h *BackupHandlers) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID := chi.URLParam(r, "scheduleID")
	if scheduleID == "" {
		JSONError(w, http.StatusBadRequest, "schedule ID required")
		return
	}

	if err := h.backupService.DeleteSchedule(r.Context(), scheduleID); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to delete schedule")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":  "deleted",
		"message": "Backup schedule deleted successfully",
	})
}

// DownloadBackup downloads a backup file
// GET /api/v1/backups/{backupID}/download
func (h *BackupHandlers) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	backup, err := h.backupService.GetBackup(r.Context(), backupID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "backup not found")
		return
	}

	if _, err := os.Stat(backup.Path); os.IsNotExist(err) {
		JSONError(w, http.StatusNotFound, "backup file not found")
		return
	}

	filename := filepath.Base(backup.Path)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(backup.Size, 10))

	http.ServeFile(w, r, backup.Path)
}

// UploadBackup uploads a backup file
// POST /api/v1/backups/upload
func (h *BackupHandlers) UploadBackup(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(0); err != nil {
		JSONError(w, http.StatusBadRequest, "failed to parse upload")
		return
	}

	file, header, err := r.FormFile("backup")
	if err != nil {
		JSONError(w, http.StatusBadRequest, "no backup file provided")
		return
	}
	defer file.Close()

	filename := filepath.Base(header.Filename)
	ext := filepath.Ext(filename)
	for ext != "" {
		if ext == ".tar" || ext == ".gz" || ext == ".tgz" {
			break
		}
		oldExt := ext
		ext = filepath.Ext(filename[:len(filename)-len(ext)])
		if ext == oldExt {
			break
		}
	}

	isValid := false
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	if n >= 2 && buf[0] == 0x1f && buf[1] == 0x8b {
		isValid = true
	}
	if !isValid && n >= 263 {
		if string(buf[257:262]) == "ustar" {
			isValid = true
		}
	}

	if !isValid {
		JSONError(w, http.StatusBadRequest, "invalid backup file format (must be .tar, .tar.gz, or .tgz)")
		return
	}

	backup, err := h.backupService.StoreUploadedBackup(r.Context(), filename, io.MultiReader(bytes.NewReader(buf[:n]), file), header.Size)
	if err != nil {
		log.Printf("UploadBackup: failed to store: %v", err)
		JSONError(w, http.StatusInternalServerError, "failed to store backup")
		return
	}

	JSON(w, http.StatusCreated, backup)
}

// ListUnattachedBackups lists backups not linked to any installed app
// GET /api/v1/backups/unattached
func (h *BackupHandlers) ListUnattachedBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := h.backupService.ListUnattachedBackups(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list unattached backups")
		return
	}

	for i := range backups {
		if backups[i].CloudStatus == nil {
			backups[i].CloudStatus = map[string]interface{}{"has_cloud_copy": false}
		}
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
		"count":   len(backups),
	})
}

// UploadDatabaseBackup uploads and restores a database backup
// POST /api/v1/backups/database/upload-restore
func (h *BackupHandlers) UploadDatabaseBackup(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(0); err != nil {
		JSONError(w, http.StatusBadRequest, "failed to parse upload")
		return
	}

	file, header, err := r.FormFile("backup")
	if err != nil {
		JSONError(w, http.StatusBadRequest, "no backup file provided")
		return
	}
	defer file.Close()

	filename := filepath.Base(header.Filename)
	if filepath.Ext(filename) != ".gz" && filepath.Ext(filename) != ".db" {
		JSONError(w, http.StatusBadRequest, "invalid database backup file (must be .gz or .db)")
		return
	}

	backup, err := h.backupService.StoreUploadedDatabaseBackup(r.Context(), filename, file, header.Size)
	if err != nil {
		log.Printf("UploadDatabaseBackup: failed to store: %v", err)
		JSONError(w, http.StatusInternalServerError, "failed to store database backup")
		return
	}

	JSON(w, http.StatusCreated, backup)
}
