package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
)

// AppsHandler handles installed app management API endpoints
type AppsHandler struct {
	manager *apps.Manager
}

// NewAppsHandler creates a new AppsHandler
func NewAppsHandler(manager *apps.Manager) *AppsHandler {
	return &AppsHandler{
		manager: manager,
	}
}

// InstallRequest represents an app installation request
type InstallRequest struct {
	AppID  string                 `json:"app_id"`
	Name   string                 `json:"name,omitempty"`
	Config map[string]interface{} `json:"config,omitempty"`
}

// AppsListResponse represents the list of installed apps
type AppsListResponse struct {
	Apps  []*apps.InstalledApp `json:"apps"`
	Total int                  `json:"total"`
}

// ListInstalledApps handles GET /api/apps
// Returns all installed apps
func (h *AppsHandler) ListInstalledApps(w http.ResponseWriter, r *http.Request) {
	appList, err := h.manager.ListInstalledApps(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list apps: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, AppsListResponse{
		Apps:  appList,
		Total: len(appList),
	})
}

// GetInstalledApp handles GET /api/apps/{instanceId}
// Returns details for a specific installed app
func (h *AppsHandler) GetInstalledApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	JSON(w, http.StatusOK, app)
}

// InstallApp handles POST /api/apps
// Installs a new app from the catalog
func (h *AppsHandler) InstallApp(w http.ResponseWriter, r *http.Request) {
	var req InstallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.AppID == "" {
		JSONError(w, http.StatusBadRequest, "app_id is required")
		return
	}

	// Validate config against app definition
	installer := h.manager.GetInstaller()
	if err := installer.ValidateConfig(req.AppID, req.Config); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid configuration: "+err.Error())
		return
	}

	// Install the app
	result, err := installer.Install(r.Context(), apps.InstallOptions{
		AppID:  req.AppID,
		Name:   req.Name,
		Config: req.Config,
	})

	if err != nil {
		JSONError(w, http.StatusInternalServerError, "installation failed: "+err.Error())
		return
	}

	if !result.Success {
		JSONError(w, http.StatusInternalServerError, result.Error)
		return
	}

	JSON(w, http.StatusCreated, result)
}

// StartApp handles POST /api/apps/{instanceId}/start
// Starts a stopped app
func (h *AppsHandler) StartApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	if err := h.manager.StartApp(r.Context(), instanceID); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to start app: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app started",
		"instance_id": instanceID,
	})
}

// StopApp handles POST /api/apps/{instanceId}/stop
// Stops a running app
func (h *AppsHandler) StopApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	if err := h.manager.StopApp(r.Context(), instanceID); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to stop app: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app stopped",
		"instance_id": instanceID,
	})
}

// RestartApp handles POST /api/apps/{instanceId}/restart
// Restarts an app
func (h *AppsHandler) RestartApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	if err := h.manager.RestartApp(r.Context(), instanceID); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to restart app: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app restarted",
		"instance_id": instanceID,
	})
}

// UpdateApp handles POST /api/apps/{instanceId}/update
// Updates an app to the latest version
func (h *AppsHandler) UpdateApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	if err := h.manager.UpdateApp(r.Context(), instanceID); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to update app: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app updated",
		"instance_id": instanceID,
	})
}

// UninstallApp handles DELETE /api/apps/{instanceId}
// Uninstalls an app and removes its data
func (h *AppsHandler) UninstallApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	if err := h.manager.UninstallApp(r.Context(), instanceID); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to uninstall app: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app uninstalled",
		"instance_id": instanceID,
	})
}

// GetAppStatus handles GET /api/apps/{instanceId}/status
// Returns the current status of an app
func (h *AppsHandler) GetAppStatus(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	status, err := h.manager.GetAppStatus(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	JSON(w, http.StatusOK, status)
}
