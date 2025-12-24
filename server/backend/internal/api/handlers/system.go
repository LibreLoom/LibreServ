package handlers

import (
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
	info, err := h.checker.CheckForUpdates(Version)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to check for updates: "+err.Error())
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
		JSONError(w, http.StatusInternalServerError, "failed to apply update: "+err.Error())
		return
	}

	if h.auditLog != nil {
		h.auditLog.Log(r.Context(), "system.update", "", "libreserv", "success", "System update applied", nil)
	}

	JSON(w, http.StatusOK, map[string]string{"message": "update applied, restarting..."})
}
