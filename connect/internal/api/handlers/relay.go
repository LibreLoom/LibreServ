package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/relay"
)

// RelayHandler handles admin relay fleet operations.
type RelayHandler struct {
	svc *relay.Service
}

func NewRelayHandler(svc *relay.Service) *RelayHandler {
	return &RelayHandler{svc: svc}
}

// ListRegions returns all relay regions.
func (h *RelayHandler) ListRegions(w http.ResponseWriter, r *http.Request) {
	regions, err := h.svc.ListRegions()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list relay regions")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"regions": regions})
}

// CreateRegion adds a new relay region.
func (h *RelayHandler) CreateRegion(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		Provider   string `json:"provider"`
		Region     string `json:"region"`
		Host       string `json:"host"`
		CapacityGB int    `json:"capacity_gb"`
		IsPremium  bool   `json:"is_premium"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.Provider == "" || req.Host == "" {
		JSONError(w, http.StatusBadRequest, "name, provider, and host required")
		return
	}

	reg, err := h.svc.CreateRegion(req.Name, req.Provider, req.Region, req.Host, req.CapacityGB, req.IsPremium)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create relay region")
		return
	}
	JSON(w, http.StatusOK, reg)
}

// UpdateRegionHealth updates the health status of a relay region.
func (h *RelayHandler) UpdateRegionHealth(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		IsHealthy bool `json:"is_healthy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := h.svc.UpdateRegionHealth(id, req.IsHealthy); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not update region health")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "region health updated"})
}

// DeleteRegion removes a relay region.
func (h *RelayHandler) DeleteRegion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.DeleteRegion(id); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not delete relay region")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "region deleted"})
}

// GetFleetStatus returns aggregated relay fleet status.
func (h *RelayHandler) GetFleetStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.svc.GetFleetStatus()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get fleet status")
		return
	}
	JSON(w, http.StatusOK, status)
}
