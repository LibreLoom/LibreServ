package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

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
		JSONError(w, http.StatusInternalServerError, "We couldn't load your apps. Please try again.")
		return
	}

	JSON(w, http.StatusOK, AppsListResponse{
		Apps:  redactAppList(appList),
		Total: len(appList),
	})
}

// GetInstalledApp handles GET /api/apps/{instanceId}
// Returns details for a specific installed app
func (h *AppsHandler) GetInstalledApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		slog.Warn("Installed app not found", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	JSON(w, http.StatusOK, app.RedactForAPI())
}

// InstallApp handles POST /api/apps
// Installs a new app from the catalog
func (h *AppsHandler) InstallApp(w http.ResponseWriter, r *http.Request) {
	var req InstallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.AppID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose which app to install.")
		return
	}

	// Validate config against app definition using the manager's catalog
	// (which includes repo-based apps), not the installer's local catalog.
	catalog := h.manager.GetCatalog()
	catalogApp, err := catalog.GetApp(req.AppID)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't find that app in the catalog. It may have been removed.")
		return
	}
	installer := h.manager.GetInstaller()
	if err := installer.ValidateConfigForApp(catalogApp, req.Config); err != nil {
		slog.Error("Config validation failed", "app_id", req.AppID, "error", err)
		JSONError(w, http.StatusBadRequest, "The app's configuration isn't valid. Please check your settings and try again.")
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
		JSONError(w, http.StatusInternalServerError, "We couldn't install this app. Please try again.")
		return
	}

	if !result.Success {
		slog.Error("App install unsuccessful", "app_id", req.AppID, "error", result.Error)
		JSONError(w, http.StatusInternalServerError, "We couldn't install this app. Please try again.")
		return
	}

	// Populate the public URL (correct http/https scheme) so the UI's
	// "Open App" link points at the real domain instead of a localhost URL.
	h.manager.EnsurePublicURL(result.App)

	if result.App != nil {
		result.App = result.App.RedactForAPI()
	}
	JSON(w, http.StatusCreated, result)
}

// redactAppList returns a slice of apps with sensitive config stripped for API responses.
func redactAppList(list []*apps.InstalledApp) []*apps.InstalledApp {
	redacted := make([]*apps.InstalledApp, len(list))
	for i, app := range list {
		redacted[i] = app.RedactForAPI()
	}
	return redacted
}

// StartApp handles POST /api/apps/{instanceId}/start
// Starts a stopped app
func (h *AppsHandler) StartApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	if app.RevocationNotice != nil && app.RevocationNotice.AcknowledgedAt == nil {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":      "This version has been recalled for security reasons and cannot be started right now. Check the app details for more information.",
			"revocation": app.RevocationNotice,
		})
		return
	}

	if err := h.manager.StartApp(r.Context(), instanceID); err != nil {
		slog.Error("We couldn't start this app. Please try again.", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't start this app. Please try again.")
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
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	if err := h.manager.StopApp(r.Context(), instanceID); err != nil {
		slog.Error("We couldn't stop this app. Please try again.", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't stop this app. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app stopped",
		"instance_id": instanceID,
	})
}

// AcknowledgeRevocation handles POST /api/apps/{instanceId}/acknowledge-revocation
// Dismisses the revocation warning for a revoked app
func (h *AppsHandler) AcknowledgeRevocation(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	if err := h.manager.AcknowledgeRevocation(r.Context(), instanceID); err != nil {
		slog.Error("We couldn't acknowledge the revocation. Please try again.", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't acknowledge the revocation. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "revocation acknowledged",
		"instance_id": instanceID,
	})
}

// RestartApp handles POST /api/apps/{instanceId}/restart
// Restarts an app
func (h *AppsHandler) RestartApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	if err := h.manager.RestartApp(r.Context(), instanceID); err != nil {
		slog.Error("We couldn't restart this app. Please try again.", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't restart this app. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":     "app restarted",
		"instance_id": instanceID,
	})
}

// UpdateApp handles POST /api/apps/{instanceId}/update
// Updates an app to the latest version.
// Query param: override_pin=true to override a pinned version.
func (h *AppsHandler) UpdateApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	overridePin := r.URL.Query().Get("override_pin") == "true"

	if err := h.manager.UpdateApp(r.Context(), instanceID, overridePin); err != nil {
		slog.Error("We couldn't update this app. Please try again.", "instance_id", instanceID, "error", err)
		if h.auditLog != nil {
			h.auditLog.Log(r.Context(), "app.update", instanceID, "", "failure", err.Error(), nil)
		}

		msg := err.Error()
		if strings.HasPrefix(msg, "needs_config:") {
			JSONError(w, http.StatusConflict, strings.TrimPrefix(msg, "needs_config:"))
			return
		}
		if strings.Contains(msg, "pinned") {
			JSONError(w, http.StatusConflict, "The app version is pinned and cannot be updated")
			return
		}

		JSONError(w, http.StatusInternalServerError, "We couldn't update this app. Please try again.")
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
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	if err := h.manager.UninstallApp(r.Context(), instanceID); err != nil {
		slog.Error("We couldn't uninstall this app. Please try again.", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't uninstall this app. Please try again.")
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
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	status, err := h.manager.GetAppStatus(r.Context(), instanceID)
	if err != nil {
		slog.Warn("App status not found", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
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
		JSONError(w, http.StatusInternalServerError, "We couldn't load the update history. Please try again.")
		return
	}

	JSON(w, http.StatusOK, history)
}

// GetAppUpdateHistory handles GET /api/apps/{instanceId}/updates/history
// Returns the update history for a specific app
func (h *AppsHandler) GetAppUpdateHistory(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	history, err := h.manager.ListUpdateHistory(r.Context(), instanceID)
	if err != nil {
		slog.Error("Failed to get app update history", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't load the update history. Please try again.")
		return
	}

	JSON(w, http.StatusOK, history)
}

// GetAvailableUpdates handles GET /api/apps/updates/available
// Returns a list of apps with available updates
func (h *AppsHandler) GetAvailableUpdates(w http.ResponseWriter, r *http.Request) {
	updates, err := h.manager.GetAvailableUpdates(r.Context())
	if err != nil {
		slog.Error("We couldn't check for updates. Please try again.", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't check for updates. Please try again.")
		return
	}

	JSON(w, http.StatusOK, updates)
}

// PinAppVersion handles POST /api/apps/{instanceId}/pin
// Locks an app to a specific version
func (h *AppsHandler) PinAppVersion(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	var req struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Version == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a version to pin.")
		return
	}

	if err := h.manager.PinAppVersion(r.Context(), instanceID, req.Version); err != nil {
		slog.Error("We couldn't pin the app version. Please try again.", "instance_id", instanceID, "version", req.Version, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't pin the app version. Please try again.")
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
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	if err := h.manager.UnpinAppVersion(r.Context(), instanceID); err != nil {
		slog.Error("We couldn't unpin the app version. Please try again.", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't unpin the app version. Please try again.")
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
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	fieldName := chi.URLParam(r, "fieldName")
	if fieldName == "" {
		JSONError(w, http.StatusBadRequest, "Please specify which field to read.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		slog.Warn("Exposed info: app not found", "instance_id", instanceID, "error", err)
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	value, ok := app.ExposedInfo[fieldName]
	if !ok {
		JSONError(w, http.StatusNotFound, "We couldn't find that field for the app.")
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

// ReconfigureRequest is the request body for reconfiguring an installed app.
// Only keys declared in the app's catalog Configuration schema are accepted;
// unknown keys are silently dropped by the manager.
type ReconfigureRequest struct {
	Config map[string]interface{} `json:"config"`
}

// ReconfigureApp handles PUT /api/apps/{instanceId}/config
// Updates an installed app's configuration and restarts it with the new settings.
func (h *AppsHandler) ReconfigureApp(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app to use. Please refresh and try again.")
		return
	}

	var req ReconfigureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Config == nil {
		JSONError(w, http.StatusBadRequest, "Please provide the configuration settings to update.")
		return
	}

	if err := h.manager.Reconfigure(r.Context(), instanceID, req.Config); err != nil {
		slog.Error("App reconfigure failed", "instance_id", instanceID, "error", err)
		if h.auditLog != nil {
			h.auditLog.Log(r.Context(), "app.reconfigure", instanceID, "", "failure", err.Error(), nil)
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't update this app's settings. "+err.Error())
		return
	}

	if h.auditLog != nil {
		h.auditLog.Log(r.Context(), "app.reconfigure", instanceID, "", "success", "App settings updated", nil)
	}

	// Return the updated app (redacted) so the frontend has fresh state.
	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSON(w, http.StatusOK, map[string]string{
			"message":     "app reconfigured",
			"instance_id": instanceID,
		})
		return
	}
	JSON(w, http.StatusOK, app.RedactForAPI())
}
