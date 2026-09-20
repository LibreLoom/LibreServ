package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/models"
)

// ModelsHandler handles admin AI provider/model configuration.
type ModelsHandler struct {
	svc *models.Service
}

func NewModelsHandler(svc *models.Service) *ModelsHandler {
	return &ModelsHandler{svc: svc}
}

// ListProviders returns all AI providers.
func (h *ModelsHandler) ListProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := h.svc.ListProviders()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list providers")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"providers": providers})
}

// CreateProvider creates a new AI provider.
func (h *ModelsHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string `json:"name"`
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
		Tier    string `json:"tier"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.BaseURL == "" {
		JSONError(w, http.StatusBadRequest, "name and base_url required")
		return
	}
	if req.Tier == "" {
		req.Tier = "paid"
	}

	p, err := h.svc.CreateProvider(req.Name, req.BaseURL, req.APIKey, req.Tier, req.Enabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create provider")
		return
	}
	JSON(w, http.StatusOK, p)
}

// UpdateProvider updates an existing provider.
func (h *ModelsHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		Name    string `json:"name"`
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
		Tier    string `json:"tier"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := h.svc.UpdateProvider(id, req.Name, req.BaseURL, req.APIKey, req.Tier, req.Enabled); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not update provider")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "provider updated"})
}

// DeleteProvider removes a provider.
func (h *ModelsHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.DeleteProvider(id); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not delete provider")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "provider deleted"})
}

// ListModels returns all AI models, optionally filtered by role.
func (h *ModelsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	models, err := h.svc.ListModels(role)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list models")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"models": models})
}

// CreateModel creates a new AI model.
func (h *ModelsHandler) CreateModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID            string  `json:"provider_id"`
		ModelID               string  `json:"model_id"`
		DisplayName           string  `json:"display_name"`
		Role                  string  `json:"role"`
		InputPricePerMillion  float64 `json:"input_price_per_million"`
		OutputPricePerMillion float64 `json:"output_price_per_million"`
		CachePricePerMillion  float64 `json:"cache_price_per_million"`
		ContextWindow         int     `json:"context_window"`
		Enabled               bool    `json:"enabled"`
		SortOrder             int     `json:"sort_order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ProviderID == "" || req.ModelID == "" {
		JSONError(w, http.StatusBadRequest, "provider_id and model_id required")
		return
	}
	if req.Role == "" {
		req.Role = "agent"
	}

	m, err := h.svc.CreateModel(req.ProviderID, req.ModelID, req.DisplayName, req.Role,
		req.InputPricePerMillion, req.OutputPricePerMillion, req.CachePricePerMillion,
		req.ContextWindow, req.Enabled, req.SortOrder)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create model")
		return
	}
	JSON(w, http.StatusOK, m)
}

// UpdateModel updates an existing model.
func (h *ModelsHandler) UpdateModel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		ModelID               string  `json:"model_id"`
		DisplayName           string  `json:"display_name"`
		Role                  string  `json:"role"`
		InputPricePerMillion  float64 `json:"input_price_per_million"`
		OutputPricePerMillion float64 `json:"output_price_per_million"`
		CachePricePerMillion  float64 `json:"cache_price_per_million"`
		ContextWindow         int     `json:"context_window"`
		Enabled               bool    `json:"enabled"`
		SortOrder             int     `json:"sort_order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	if err := h.svc.UpdateModel(id, req.ModelID, req.DisplayName, req.Role,
		req.InputPricePerMillion, req.OutputPricePerMillion, req.CachePricePerMillion,
		req.ContextWindow, req.Enabled, req.SortOrder); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not update model")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "model updated"})
}

// DeleteModel removes a model.
func (h *ModelsHandler) DeleteModel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.DeleteModel(id); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not delete model")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "model deleted"})
}

// GetFallbackChain returns the fallback chain for a role/tier.
func (h *ModelsHandler) GetFallbackChain(w http.ResponseWriter, r *http.Request) {
	role := chi.URLParam(r, "role")
	tier := r.URL.Query().Get("tier")
	if tier == "" {
		tier = "paid"
	}

	chain, err := h.svc.GetFallbackChain(role, tier)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get fallback chain")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"role": role, "tier": tier, "chain": chain})
}
