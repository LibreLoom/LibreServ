package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/backup/cloud"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

type CloudBackupHandlers struct {
	cloudService  *cloud.Service
	backupService *storage.BackupService
}

func NewCloudBackupHandlers(cloudService *cloud.Service, backupService *storage.BackupService) *CloudBackupHandlers {
	return &CloudBackupHandlers{
		cloudService:  cloudService,
		backupService: backupService,
	}
}

func (h *CloudBackupHandlers) ListProviders(w http.ResponseWriter, r *http.Request) {
	providers := h.cloudService.GetSupportedProviders()
	JSON(w, http.StatusOK, map[string]interface{}{
		"providers": providers,
	})
}

func (h *CloudBackupHandlers) GetConfig(w http.ResponseWriter, r *http.Request) {
	config, err := h.cloudService.LoadConfig(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if config == nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"configured": false,
			"config":     nil,
		})
		return
	}

	config.KeySecret = ""

	JSON(w, http.StatusOK, map[string]interface{}{
		"configured": true,
		"config":     config,
	})
}

type SaveCloudConfigRequest struct {
	Provider  string `json:"provider"`
	Bucket    string `json:"bucket"`
	Region    string `json:"region"`
	KeyID     string `json:"key_id"`
	KeySecret string `json:"key_secret"`
	Endpoint  string `json:"endpoint"`
	Enabled   bool   `json:"enabled"`
}

func (h *CloudBackupHandlers) SaveConfig(w http.ResponseWriter, r *http.Request) {
	var req SaveCloudConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Provider == "" {
		JSONError(w, http.StatusBadRequest, "provider is required")
		return
	}

	provider := cloud.Provider(req.Provider)
	if provider != cloud.ProviderBackblaze && provider != cloud.ProviderS3 && provider != cloud.ProviderManual {
		JSONError(w, http.StatusBadRequest, "invalid provider")
		return
	}

	if provider != cloud.ProviderManual {
		if req.Bucket == "" {
			JSONError(w, http.StatusBadRequest, "bucket is required")
			return
		}
		if req.KeyID == "" {
			JSONError(w, http.StatusBadRequest, "key_id is required")
			return
		}
		if req.KeySecret == "" {
			JSONError(w, http.StatusBadRequest, "key_secret is required")
			return
		}
	}

	config := &cloud.CloudConfig{
		ID:        "default",
		Provider:  provider,
		Bucket:    req.Bucket,
		Region:    req.Region,
		KeyID:     req.KeyID,
		KeySecret: req.KeySecret,
		Endpoint:  req.Endpoint,
		Enabled:   req.Enabled,
	}

	if err := h.cloudService.SaveConfig(r.Context(), config); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	config.KeySecret = ""

	JSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"config":  config,
	})
}

func (h *CloudBackupHandlers) TestConnection(w http.ResponseWriter, r *http.Request) {
	result, err := h.cloudService.TestConnection(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, result)
}

func (h *CloudBackupHandlers) UploadBackup(w http.ResponseWriter, r *http.Request) {
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

	if err := h.cloudService.UploadBackupAsync(backupID, backup.Path); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusAccepted, map[string]interface{}{
		"status":    "uploading",
		"backup_id": backupID,
	})
}

func (h *CloudBackupHandlers) GetUploadStatus(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	job := h.cloudService.GetUploadStatus(backupID)
	if job == nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"status": "not_found",
		})
		return
	}

	JSON(w, http.StatusOK, job)
}

func (h *CloudBackupHandlers) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	localPath := "/tmp/libreserv-restore-" + backupID + ".tar.gz"

	if err := h.cloudService.DownloadBackup(r.Context(), backupID, localPath); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":     "downloaded",
		"backup_id":  backupID,
		"local_path": localPath,
	})
}

func (h *CloudBackupHandlers) ListRemoteBackups(w http.ResponseWriter, r *http.Request) {
	backups, err := h.cloudService.ListRemoteBackups(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
		"count":   len(backups),
	})
}

func (h *CloudBackupHandlers) GetBackupCloudStatus(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if backupID == "" {
		JSONError(w, http.StatusBadRequest, "backup ID required")
		return
	}

	status, err := h.cloudService.GetBackupCloudStatus(r.Context(), backupID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, status)
}
