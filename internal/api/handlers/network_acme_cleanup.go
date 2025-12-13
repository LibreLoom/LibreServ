package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// ACME Post-issuance cleanup: remove acme-auto routes.
type ACMECleanupHandler struct {
	caddy *network.CaddyManager
}

func NewACMECleanupHandler(caddy *network.CaddyManager) *ACMECleanupHandler {
	return &ACMECleanupHandler{caddy: caddy}
}

// DELETE /api/v1/network/acme/routes/{routeID}
func (h *ACMECleanupHandler) DeleteRoute(w http.ResponseWriter, r *http.Request) {
	if h.caddy == nil {
		JSONError(w, http.StatusInternalServerError, "caddy manager not configured")
		return
	}
	id := chi.URLParam(r, "routeID")
	if id == "" {
		JSONError(w, http.StatusBadRequest, "route id required")
		return
	}
	if err := h.caddy.RemoveRoute(r.Context(), id); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Attempt to reload config after deletion
	_ = h.caddy.ApplyConfig()
	JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
