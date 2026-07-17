package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
)

// ProvidersHandler handles admin service provider configuration.
type ProvidersHandler struct {
	svc *providers.Service
}

func NewProvidersHandler(svc *providers.Service) *ProvidersHandler {
	return &ProvidersHandler{svc: svc}
}

// providerRequest is the shared request body for creating/updating a provider.
type providerRequest struct {
	Service     string            `json:"service"`
	Name        string            `json:"name"`
	Credentials map[string]string `json:"credentials"`
	Settings    map[string]string `json:"settings"`
	Enabled     bool              `json:"enabled"`
}

// ListProviders returns all service providers, optionally filtered by service.
func (h *ProvidersHandler) ListProviders(w http.ResponseWriter, r *http.Request) {
	service := r.URL.Query().Get("service")
	providers, err := h.svc.List(service)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list service providers")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"providers": providers})
}

// CreateProvider creates a new service provider.
func (h *ProvidersHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var req providerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Service == "" || req.Name == "" {
		JSONError(w, http.StatusBadRequest, "service and name are required")
		return
	}

	p, err := h.svc.Create(req.Service, req.Name, req.Credentials, req.Settings, req.Enabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create service provider")
		return
	}
	JSON(w, http.StatusOK, p)
}

// UpdateProvider updates an existing service provider.
func (h *ProvidersHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req providerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Service == "" || req.Name == "" {
		JSONError(w, http.StatusBadRequest, "service and name are required")
		return
	}

	if err := h.svc.Update(id, req.Service, req.Name, req.Credentials, req.Settings, req.Enabled); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not update service provider")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "provider updated"})
}

// DeleteProvider removes a service provider.
func (h *ProvidersHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.Delete(id); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not delete service provider")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "provider deleted"})
}
