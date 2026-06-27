package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// ACMECleanupHandler handles post-issuance cleanup for ACME routes.
type ACMECleanupHandler struct {
	caddy *network.CaddyManager
}

// NewACMECleanupHandler creates a cleanup handler backed by Caddy.
func NewACMECleanupHandler(caddy *network.CaddyManager) *ACMECleanupHandler {
	return &ACMECleanupHandler{caddy: caddy}
}

// DeleteRoute removes an ACME auto-issued route by ID.
func (h *ACMECleanupHandler) DeleteRoute(w http.ResponseWriter, r *http.Request) {
	if h.caddy == nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't reach the proxy service. Please try again later.")
		return
	}
	id := chi.URLParam(r, "routeID")
	if id == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which route. Please check and try again.")
		return
	}
	if err := h.caddy.RemoveRoute(r.Context(), id); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't remove that route. Please try again.")
		return
	}
	// Attempt to reload config after deletion
	_ = h.caddy.ApplyConfig()
	JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
