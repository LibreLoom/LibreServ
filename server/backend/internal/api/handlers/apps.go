package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
)

// AppsHandler handles installed app management API endpoints
type AppsHandler struct {
	manager  *apps.Manager
	auditLog AuditLogger
}

// NewAppsHandler creates a new AppsHandler
func NewAppsHandler(manager *apps.Manager) *AppsHandler {
	return &AppsHandler{
		manager: manager,
	}
}

// SetAuditLogger sets the audit logging callback
func (h *AppsHandler) SetAuditLogger(logger AuditLogger) {
	h.auditLog = logger
}

// InstallRequest represents an app installation request
type InstallRequest struct {
	AppID        string                 `json:"app_id"`
	Name         string                 `json:"name"`
	Config       map[string]interface{} `json:"config"`
	DomainConfig *apps.DomainConfig     `json:"domain_config,omitempty"`
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
		slog.Error("Failed to list installed apps", "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to retrieve apps")
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
		slog.Warn("Installed app not found", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusNotFound, "App not found")
		return
	}

	JSON(w, http.StatusOK, app)
}

// InstallApp handles POST /api/apps
// Installs a new app from the catalog
func (h *AppsHandler) InstallApp(w http.ResponseWriter, r *http.Request) {
	var req InstallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.AppID == "" {
		JSONError(w, http.StatusBadRequest, "app_id is required")
		return
	}

	// Validate config against app definition
	installer := h.manager.GetInstaller()
	if err := installer.ValidateConfig(req.AppID, req.Config); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid configuration")
		return
	}

	// Set domain config for this install (temporary)
	if req.DomainConfig != nil {
		installer.SetDomainConfig(req.DomainConfig)
		defer installer.ClearDomainConfig()
	}

	// Install the app
	result, err := installer.Install(r.Context(), apps.InstallOptions{
		AppID:  req.AppID,
		Name:   req.Name,
		Config: req.Config,
	})

	if err != nil {
		slog.Error("App install failed", "app_id", req.AppID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Installation failed")
		return
	}

	if !result.Success {
		slog.Error("App install unsuccessful", "app_id", req.AppID, "error", result.Error)
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
		slog.Error("Failed to start app", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to start app")
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
		slog.Error("Failed to stop app", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to stop app")
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
		slog.Error("Failed to restart app", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to restart app")
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
		slog.Error("Failed to update app", "instance_id", instanceID, "error", err)
		if h.auditLog != nil {
			h.auditLog.Log(r.Context(), "app.update", instanceID, "", "failure", err.Error(), nil)
		}
		JSONError(w, http.StatusInternalServerError, "Failed to update app")
		return
	}

	if h.auditLog != nil {
		h.auditLog.Log(r.Context(), "app.update", instanceID, "", "success", "Manual update triggered", nil)
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
		slog.Error("Failed to uninstall app", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to uninstall app")
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
		slog.Warn("App status not found", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusNotFound, "App not found")
		return
	}

	JSON(w, http.StatusOK, status)
}

// GetUpdateHistory handles GET /api/apps/updates/history
// Returns the update history for all apps
func (h *AppsHandler) GetUpdateHistory(w http.ResponseWriter, r *http.Request) {
	history, err := h.manager.ListUpdateHistory(r.Context(), "")
	if err != nil {
		slog.Error("Failed to get update history", "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to retrieve update history")
		return
	}

	JSON(w, http.StatusOK, history)
}

// GetAppUpdateHistory handles GET /api/apps/{instanceId}/updates/history
// Returns the update history for a specific app
func (h *AppsHandler) GetAppUpdateHistory(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	history, err := h.manager.ListUpdateHistory(r.Context(), instanceID)
	if err != nil {
		slog.Error("Failed to get app update history", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to retrieve update history")
		return
	}

	JSON(w, http.StatusOK, history)
}

// GetAvailableUpdates handles GET /api/apps/updates/available
// Returns a list of apps with available updates
func (h *AppsHandler) GetAvailableUpdates(w http.ResponseWriter, r *http.Request) {
	updates, err := h.manager.GetAvailableUpdates(r.Context())
	if err != nil {
		slog.Error("Failed to check for updates", "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to check for updates")
		return
	}

	JSON(w, http.StatusOK, updates)
}

// PinAppVersion handles POST /api/apps/{instanceId}/pin
// Locks an app to a specific version
func (h *AppsHandler) PinAppVersion(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	var req struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Version == "" {
		JSONError(w, http.StatusBadRequest, "version is required")
		return
	}

	if err := h.manager.PinAppVersion(r.Context(), instanceID, req.Version); err != nil {
		slog.Error("Failed to pin app version", "instance_id", instanceID, "version", req.Version, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to pin app version")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app version pinned",
		"instance_id": instanceID,
		"version":     req.Version,
	})
}

// UnpinAppVersion handles POST /api/apps/{instanceId}/unpin
// Removes version lock from an app
func (h *AppsHandler) UnpinAppVersion(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	if err := h.manager.UnpinAppVersion(r.Context(), instanceID); err != nil {
		slog.Error("Failed to unpin app version", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "Failed to unpin app version")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app version unpinned",
		"instance_id": instanceID,
	})
}

// GetExposedInfoField handles GET /api/apps/{instanceId}/exposed-info/{fieldName}
// Returns a specific exposed info field value
func (h *AppsHandler) GetExposedInfoField(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	fieldName := chi.URLParam(r, "fieldName")
	if fieldName == "" {
		JSONError(w, http.StatusBadRequest, "field name is required")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		slog.Warn("Exposed info: app not found", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusNotFound, "App not found")
		return
	}

	value, ok := app.ExposedInfo[fieldName]
	if !ok {
		JSONError(w, http.StatusNotFound, "Exposed info field not found")
		return
	}

	JSON(w, http.StatusOK, value)
}

// ListAllocatedPorts handles GET /api/apps/ports
// Returns all currently allocated port numbers and which app owns them.
func (h *AppsHandler) ListAllocatedPorts(w http.ResponseWriter, r *http.Request) {
	pm := h.manager.GetPortManager()
	if pm == nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"ports": map[string]string{},
		})
		return
	}

	usedPorts := pm.GetUsedPorts()

	// Convert int keys to string keys for JSON
	result := make(map[string]string, len(usedPorts))
	for port, instanceID := range usedPorts {
		result[fmt.Sprintf("%d", port)] = instanceID
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"ports": result,
	})
}
