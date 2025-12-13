package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
)

// LicenseHandler exposes license/entitlement status.
type LicenseHandler struct {
	lic middleware.LicenseChecker
}

func NewLicenseHandler(lic middleware.LicenseChecker) *LicenseHandler {
	return &LicenseHandler{lic: lic}
}

// Status returns license validity, reason, support level, and license ID.
// GET /api/v1/license/status
func (h *LicenseHandler) Status(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, LicenseSnapshot(h.lic))
}

// LicenseSnapshot builds a JSON-friendly view of license state.
func LicenseSnapshot(lic middleware.LicenseChecker) map[string]interface{} {
	if lic == nil {
		return map[string]interface{}{
			"valid":  false,
			"reason": "license service not configured",
		}
	}
	return map[string]interface{}{
		"valid":         lic.Valid(),
		"support_level": lic.SupportLevel(),
		"license_id":    lic.LicenseID(),
		"reason":        lic.Reason(),
	}
}
