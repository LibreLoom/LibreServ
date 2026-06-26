package handlers

import (
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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
)

type BackupHandlers struct {
	backupService *storage.BackupService
}

func NewBackupHandlers(backupService *storage.BackupService) *BackupHandlers {
	return &BackupHandlers{
		backupService: backupService,
	}
}

func (h *BackupHandlers) ListBackups(w http.ResponseWriter, r *http.Request) {
	appID := r.URL.Query().Get("app_id")

	backups, err := h.backupService.ListBackups(r.Context(), appID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your backups. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
		"count":   len(backups),
	})
}

func (h *BackupHandlers) GetBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup.")
		return
	}

	backup, err := h.backupService.GetBackup(r.Context(), backupID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that backup.")
		return
	}

	JSON(w, http.StatusOK, backup)
}

type CreateBackupRequest struct {
	AppID            string `json:"app_id"`
	StopBeforeBackup bool   `json:"stop_before_backup"`
}

func (h *BackupHandlers) CreateBackup(w http.ResponseWriter, r *http.Request) {
	var req CreateBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.AppID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose an app to back up.")
		return
	}

	opts := storage.BackupOptions{
		StopBeforeBackup: req.StopBeforeBackup,
	}

	result, err := h.backupService.BackupApp(r.Context(), req.AppID, opts)
	if err != nil {
		errMsg := "We couldn't complete the backup. Please try again."
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

type RestoreBackupRequest struct {
	TargetAppID         string `json:"target_app_id,omitempty"`
	StopBeforeRestore   bool   `json:"stop_before_restore"`
	RestartAfterRestore bool   `json:"restart_after_restore"`
	VerifyChecksum      bool   `json:"verify_checksum"`
}

func (h *BackupHandlers) RestoreBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup.")
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
		errMsg := "We couldn't complete the restore. Please try again."
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

func (h *BackupHandlers) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup.")
		return
	}

	if err := h.backupService.DeleteBackup(r.Context(), backupID); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't delete that backup. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":  "deleted",
		"message": "Backup deleted successfully",
	})
}

func (h *BackupHandlers) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup.")
		return
	}

	archivePath, cleanup, err := h.backupService.CreateDownloadArchive(r.Context(), backupID)
	if err != nil {
		log.Printf("DownloadBackup: %v", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't prepare the backup for download. Please try again.")
		return
	}
	defer cleanup()

	info, err := os.Stat(archivePath)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't find the backup file.")
		return
	}

	// Sanitize backup ID for safe filename (UUID hex chars only: 0-9, a-f)
	safeID := make([]byte, 0, len(backupID))
	for _, r := range []byte(backupID[:8]) {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') {
			safeID = append(safeID, r)
		} else {
			safeID = append(safeID, '_')
		}
	}
	filename := fmt.Sprintf("libreserv-backup-%s.tar.gz", safeID)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))

	http.ServeFile(w, r, archivePath)
}

func (h *BackupHandlers) CreateDatabaseBackup(w http.ResponseWriter, r *http.Request) {
	backup, err := h.backupService.BackupDatabase(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't create the database backup. Please try again.")
		return
	}

	if _, err := os.Stat(backup.Path); os.IsNotExist(err) {
		JSONError(w, http.StatusNotFound, "We couldn't find that backup file.")
		return
	}

	filename := filepath.Base(backup.Path)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(backup.Size, 10))

	http.ServeFile(w, r, backup.Path)
	_ = os.Remove(backup.Path)
	_ = h.backupService.DeleteDatabaseBackupRecord(r.Context(), backup.ID)
}

func (h *BackupHandlers) ListDatabaseBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := h.backupService.ListDatabaseBackups(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load the database backups. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
		"count":   len(backups),
	})
}

type RestoreDatabaseBackupRequest struct {
	VerifyChecksum bool `json:"verify_checksum"`
}

func (h *BackupHandlers) RestoreDatabaseBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup.")
		return
	}

	req := RestoreDatabaseBackupRequest{VerifyChecksum: true}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	opts := storage.DatabaseRestoreOptions{VerifyChecksum: req.VerifyChecksum}

	if err := h.backupService.RestoreDatabase(r.Context(), backupID, opts); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't restore the database backup. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backup_id": backupID,
		"status":    "restored",
	})
}

func (h *BackupHandlers) UploadDatabaseBackup(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read the uploaded file. Please check the format and try again.")
		return
	}

	file, header, err := r.FormFile("backup")
	if err != nil {
		JSONError(w, http.StatusBadRequest, "Please choose a backup file to upload.")
		return
	}
	defer file.Close()

	filename := filepath.Base(header.Filename)
	if filepath.Ext(filename) != ".gz" && filepath.Ext(filename) != ".db" {
		JSONError(w, http.StatusBadRequest, "That file type isn't supported. Please upload a .gz or .db backup file.")
		return
	}

	backup, err := h.backupService.StoreUploadedDatabaseBackup(r.Context(), filename, file, header.Size)
	if err != nil {
		log.Printf("UploadDatabaseBackup: failed to store: %v", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't save the database backup. Please try again.")
		return
	}

	if err := h.backupService.RestoreDatabase(r.Context(), backup.ID, storage.DatabaseRestoreOptions{
		VerifyChecksum: true,
	}); err != nil {
		log.Printf("UploadDatabaseBackup: failed to restore: %v", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't restore the database backup. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "Database restored successfully",
	})
}

func (h *BackupHandlers) ListSchedules(w http.ResponseWriter, r *http.Request) {
	schedules, err := h.backupService.ListSchedules(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your backup schedules. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"schedules": schedules,
		"count":     len(schedules),
	})
}

func (h *BackupHandlers) GetSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID := chi.URLParam(r, "scheduleID")
	if scheduleID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup schedule.")
		return
	}

	schedule, err := h.backupService.GetSchedule(r.Context(), scheduleID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that backup schedule.")
		return
	}

	JSON(w, http.StatusOK, schedule)
}

type CreateScheduleRequest struct {
	AppID            string `json:"app_id"`
	Type             string `json:"type"`
	CronExpr         string `json:"cron_expr"`
	Enabled          bool   `json:"enabled"`
	StopBeforeBackup bool   `json:"stop_before_backup"`
	Retention        int    `json:"retention"`
}

func (h *BackupHandlers) CreateSchedule(w http.ResponseWriter, r *http.Request) {
	var req CreateScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.CronExpr == "" {
		JSONError(w, http.StatusBadRequest, "Please provide a schedule pattern for the backup.")
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
		},
		Retention: req.Retention,
		CreatedAt: time.Now(),
	}

	if err := h.backupService.CreateSchedule(r.Context(), schedule); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't create the backup schedule. Please try again.")
		return
	}

	JSON(w, http.StatusCreated, schedule)
}

type UpdateScheduleRequest struct {
	CronExpr         string `json:"cron_expr,omitempty"`
	Enabled          *bool  `json:"enabled,omitempty"`
	StopBeforeBackup *bool  `json:"stop_before_backup,omitempty"`
	Retention        *int   `json:"retention,omitempty"`
}

func (h *BackupHandlers) UpdateSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID := chi.URLParam(r, "scheduleID")
	if scheduleID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup schedule.")
		return
	}

	var req UpdateScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	schedule, err := h.backupService.GetSchedule(r.Context(), scheduleID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that backup schedule.")
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
	if req.Retention != nil {
		schedule.Retention = *req.Retention
	}

	if err := h.backupService.UpdateSchedule(r.Context(), schedule); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't update the backup schedule. Please try again.")
		return
	}

	JSON(w, http.StatusOK, schedule)
}

func (h *BackupHandlers) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	scheduleID := chi.URLParam(r, "scheduleID")
	if scheduleID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup schedule.")
		return
	}

	if err := h.backupService.DeleteSchedule(r.Context(), scheduleID); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't delete the backup schedule. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":  "deleted",
		"message": "Backup schedule deleted successfully",
	})
}

func (h *BackupHandlers) ListRepositories(w http.ResponseWriter, r *http.Request) {
	repos, err := h.backupService.ListRepositories(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your backup locations. Please try again.")
		return
	}

	type safeRepo struct {
		ID        string    `json:"id"`
		AppID     string    `json:"app_id,omitempty"`
		RepoType  string    `json:"repo_type"`
		RepoPath  string    `json:"repo_path"`
		CreatedAt time.Time `json:"created_at"`
		UpdatedAt time.Time `json:"updated_at"`
	}

	safe := make([]safeRepo, len(repos))
	for i, repo := range repos {
		safe[i] = safeRepo{
			ID:        repo.ID,
			AppID:     repo.AppID,
			RepoType:  repo.RepoType,
			RepoPath:  repo.RepoPath,
			CreatedAt: repo.CreatedAt,
			UpdatedAt: repo.UpdatedAt,
		}
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"repositories": safe,
		"count":        len(safe),
	})
}

type CreateRepositoryRequest struct {
	AppID             string            `json:"app_id"`
	RepoType          string            `json:"repo_type"`
	RepoPath          string            `json:"repo_path"`
	Credentials       map[string]string `json:"credentials,omitempty"`
	LimitUploadKbps   int               `json:"limit_upload_kbps,omitempty"`
	LimitDownloadKbps int               `json:"limit_download_kbps,omitempty"`
}

func (h *BackupHandlers) CreateRepository(w http.ResponseWriter, r *http.Request) {
	var req CreateRepositoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.RepoType == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup location type.")
		return
	}
	if req.RepoPath == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a path for the backup location.")
		return
	}

	if !h.backupService.UseRestic() {
		JSONError(w, http.StatusPreconditionFailed, "Backup storage isn't ready yet. Please set up a backup location first.")
		return
	}

	var credsJSON string
	if len(req.Credentials) > 0 {
		creds, err := json.Marshal(req.Credentials)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "We couldn't save the backup location credentials. Please try again.")
			return
		}
		credsJSON = string(creds)
	}

	repo := &storage.BackupRepository{
		ID:                uuid.New().String(),
		AppID:             req.AppID,
		RepoType:          req.RepoType,
		RepoPath:          req.RepoPath,
		Password:          h.backupService.DeriveRepoPassword(req.AppID),
		Credentials:       credsJSON,
		LimitUploadKbps:   req.LimitUploadKbps,
		LimitDownloadKbps: req.LimitDownloadKbps,
		CreatedAt:         time.Now(),
		UpdatedAt:         time.Now(),
	}

	if err := h.backupService.CreateRepository(r.Context(), repo); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't create the backup location. Please try again.")
		return
	}

	JSON(w, http.StatusCreated, map[string]interface{}{
		"id":        repo.ID,
		"repo_type": repo.RepoType,
		"repo_path": repo.RepoPath,
	})
}

func (h *BackupHandlers) DeleteRepository(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	if repoID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup location.")
		return
	}

	if err := h.backupService.DeleteRepository(r.Context(), repoID); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't delete that backup location. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type TestRepositoryRequest struct {
	AppID       string            `json:"app_id,omitempty"`
	RepoType    string            `json:"repo_type"`
	RepoPath    string            `json:"repo_path"`
	Credentials map[string]string `json:"credentials,omitempty"`
}

func (h *BackupHandlers) TestRepository(w http.ResponseWriter, r *http.Request) {
	var req TestRepositoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if !h.backupService.UseRestic() {
		JSONError(w, http.StatusPreconditionFailed, "Backup storage isn't ready yet. Please set up a backup location first.")
		return
	}

	repoConfig := restic.RepoConfig{
		Type:     req.RepoType,
		Path:     req.RepoPath,
		Password: h.backupService.DeriveRepoPassword(req.AppID),
		Env:      req.Credentials,
	}

	if err := h.backupService.TestRepository(r.Context(), repoConfig); err != nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"success": false,
			"message": err.Error(),
		})
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Connection successful",
	})
}

func (h *BackupHandlers) GetBackupCapabilities(w http.ResponseWriter, r *http.Request) {
	resticAvailable := h.backupService.UseRestic()

	JSON(w, http.StatusOK, map[string]interface{}{
		"restic_available": resticAvailable,
		"formats":          []string{"restic"},
		"features": map[string]bool{
			"incremental":        resticAvailable,
			"dedup":              resticAvailable,
			"encryption_at_rest": resticAvailable,
		},
	})
}

func (h *BackupHandlers) ProvisionBackupTool(w http.ResponseWriter, r *http.Request) {
	available, err := h.backupService.ProvisionRestic()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Failed to install advanced backup tool. Please try again later.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"restic_available": available,
		"message": func() string {
			if available {
				return "Advanced backup tool installed successfully."
			}
			return "Installation failed."
		}(),
	})
}

func (h *BackupHandlers) GetRepoStats(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	if repoID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup location.")
		return
	}

	stats, err := h.backupService.GetRepoStats(r.Context(), repoID)
	if err != nil {
		log.Printf("GetRepoStats: failed for repo %s: %v", repoID, err)
		JSONError(w, http.StatusInternalServerError, "We couldn't load backup storage details. Please try again.")
		return
	}

	JSON(w, http.StatusOK, stats)
}

func (h *BackupHandlers) GetRepositoryRecoveryKey(w http.ResponseWriter, r *http.Request) {
	repoID := chi.URLParam(r, "repoID")
	if repoID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a backup location.")
		return
	}

	key, err := h.backupService.GetRepositoryRecoveryKey(r.Context(), repoID)
	if err != nil {
		log.Printf("GetRepositoryRecoveryKey: failed for repo %s: %v", repoID, err)
		JSONError(w, http.StatusInternalServerError, "Could not retrieve recovery key. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"repo_id":      repoID,
		"recovery_key": key,
		"warning":      "Keep this key safe. Without it, your backups cannot be restored.",
	})
}
