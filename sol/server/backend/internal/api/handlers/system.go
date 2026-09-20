package handlers

import (
	"errors"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

// SystemHandler handles platform-level operations
type SystemHandler struct {
	checker  *system.UpdateChecker
	auditLog AuditLogger
}

// NewSystemHandler creates a new SystemHandler
func NewSystemHandler(checker *system.UpdateChecker) *SystemHandler {
	return &SystemHandler{
		checker: checker,
	}
}

// SetAuditLogger sets the audit logging callback
func (h *SystemHandler) SetAuditLogger(logger AuditLogger) {
	h.auditLog = logger
}

// CheckUpdates handles GET /api/v1/system/updates/check
func (h *SystemHandler) CheckUpdates(w http.ResponseWriter, r *http.Request) {
	// We get the current version from the health package (where it is set at build time)
	forceRefresh := r.URL.Query().Get("force") == "true"
	info, err := h.checker.CheckForUpdates(Version, forceRefresh)
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
			h.auditLog.Log(r.Context(), "system.update", "", "libreserv", "failure", err.Error(), nil)
		}
		if errors.Is(err, system.ErrMissingChecksum) {
			JSONError(w, http.StatusBadRequest, "That update is missing a checksum file. Nothing was installed.")
			return
		}
		if errors.Is(err, system.ErrMissingSignature) {
			JSONError(w, http.StatusBadRequest, "That update is missing its signature. Nothing was installed.")
			return
		}
		if errors.Is(err, system.ErrBadSignature) {
			JSONError(w, http.StatusBadRequest, "That update could not be verified. Nothing was installed.")
			return
		}
		if errors.Is(err, system.ErrChecksumMismatch) {
			JSONError(w, http.StatusBadRequest, "That update file didn't match its checksum. Nothing was installed.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't apply the update. Please try again.")
		return
	}

	if h.auditLog != nil {
		h.auditLog.Log(r.Context(), "system.update", "", "libreserv", "success", "System update applied", nil)
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
		h.auditLog.Log(r.Context(), "system.restart", "", "libreserv", "started", "Restart requested from Troubleshooting", nil)
	}
	h.checker.RequestRestart()
	JSON(w, http.StatusAccepted, map[string]string{"message": "LibreServ is restarting. It will be back in about a minute."})
}
