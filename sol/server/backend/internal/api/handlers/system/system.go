package system

import (
	"errors"
	"net/http"

	"gt.plainskill.net/LibreLoom/Sol/internal/api/handlers/shared"
	"gt.plainskill.net/LibreLoom/Sol/internal/feed"
	"gt.plainskill.net/LibreLoom/Sol/internal/system"
)

// SystemHandler handles platform-level operations
type SystemHandler struct {
	checker  *system.UpdateChecker
	auditLog shared.AuditLogger
}

// NewSystemHandler creates a new SystemHandler
func NewSystemHandler(checker *system.UpdateChecker) *SystemHandler {
	return &SystemHandler{
		checker: checker,
	}
}

// SetAuditLogger sets the audit logging callback
func (h *SystemHandler) SetAuditLogger(logger shared.AuditLogger) {
	h.auditLog = logger
}

// CheckUpdates handles GET /api/v1/system/updates/check
func (h *SystemHandler) CheckUpdates(w http.ResponseWriter, r *http.Request) {
	// We get the current version from the health package (where it is set at build time)
	forceRefresh := r.URL.Query().Get("force") == "true"
	info, err := h.checker.CheckForUpdates(Version, forceRefresh)
	if errors.Is(err, system.ErrNoFeed) {
		JSONError(w, http.StatusNotFound, "No updates have been published on this channel yet.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't check for updates. Please try again.")
		return
	}

	JSON(w, http.StatusOK, info)
}

// ApplyUpdate handles POST /api/v1/system/updates/apply
func (h *SystemHandler) ApplyUpdate(w http.ResponseWriter, r *http.Request) {
	if err := h.checker.ApplyUpdate(r.Context(), Version); err != nil {
		if h.auditLog != nil {
			h.auditLog.Log(r.Context(), "system.update", "", "sol", "failure", err.Error(), nil)
		}
		if errors.Is(err, feed.ErrBadSignature) {
			JSONError(w, http.StatusBadRequest, "That update could not be verified. Nothing was installed.")
			return
		}
		if errors.Is(err, feed.ErrShaMismatch) || errors.Is(err, feed.ErrSizeMismatch) {
			JSONError(w, http.StatusBadRequest, "That update file didn't match its checksum. Nothing was installed.")
			return
		}
		if errors.Is(err, feed.ErrAllURLsFailed) {
			JSONError(w, http.StatusBadGateway, "We couldn't download the update. Check your internet connection and try again.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't apply the update. Please try again.")
		return
	}

	if h.auditLog != nil {
		h.auditLog.Log(r.Context(), "system.update", "", "sol", "success", "System update applied", nil)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "update applied, restarting..."})
}

// RestartNow handles POST /api/v1/system/restart — restarts the server
// process on demand (graceful shutdown, then re-exec). Backs the
// Troubleshooting page's "Restart now" step. The response may not be
// delivered because the server begins shutting down immediately, so the
// frontend treats either a response or a dropped connection as success and
// polls /health until the server is back.
func (h *SystemHandler) RestartNow(w http.ResponseWriter, r *http.Request) {
	if h.auditLog != nil {
		h.auditLog.Log(r.Context(), "system.restart", "", "sol", "started", "Restart requested from Troubleshooting", nil)
	}
	h.checker.RequestRestart()
	JSON(w, http.StatusAccepted, map[string]string{"message": "Sol is restarting. It will be back in about a minute."})
}
