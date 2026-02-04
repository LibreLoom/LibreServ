package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/pagination"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
)

// CatalogHandler handles catalog-related API endpoints
type CatalogHandler struct {
	manager *apps.Manager
}

// NewCatalogHandler creates a new CatalogHandler
func NewCatalogHandler(manager *apps.Manager) *CatalogHandler {
	return &CatalogHandler{
		manager: manager,
	}
}

// CatalogListResponse represents the catalog list response
type CatalogListResponse struct {
	Apps       []*apps.AppDefinition `json:"apps"`
	Categories []apps.AppCategory    `json:"categories"`
	Pagination pagination.Metadata   `json:"pagination"`
}

// ListApps handles GET /api/catalog
// Returns paginated apps in the catalog with optional filters
func (h *CatalogHandler) ListApps(w http.ResponseWriter, r *http.Request) {
	// Parse pagination parameters
	params := pagination.FromRequest(r)

	// Parse query parameters for filters
	query := r.URL.Query()

	filters := apps.CatalogFilters{
		Search:   query.Get("search"),
		Featured: query.Get("featured") == "true",
	}

	if category := query.Get("category"); category != "" {
		filters.Category = apps.AppCategory(category)
	}

	if appType := query.Get("type"); appType != "" {
		filters.Type = apps.AppType(appType)
	}

	catalog := h.manager.GetCatalog()
	allApps := catalog.ListApps(filters)
	categories := catalog.GetCategories()

	// Apply pagination
	totalItems := int64(len(allApps))
	start := params.Offset
	end := start + params.Limit
	if start > len(allApps) {
		start = len(allApps)
	}
	if end > len(allApps) {
		end = len(allApps)
	}
	paginatedApps := allApps[start:end]

	JSON(w, http.StatusOK, CatalogListResponse{
		Apps:       paginatedApps,
		Categories: categories,
		Pagination: pagination.CalculateMetadata(totalItems, params),
	})
}

// GetApp handles GET /api/catalog/{appId}
// Returns details for a specific app from the catalog
func (h *CatalogHandler) GetApp(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appId")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID is required")
		return
	}

	catalog := h.manager.GetCatalog()
	app, err := catalog.GetApp(appID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	JSON(w, http.StatusOK, app)
}

// GetCategories handles GET /api/catalog/categories
// Returns all available app categories
func (h *CatalogHandler) GetCategories(w http.ResponseWriter, r *http.Request) {
	catalog := h.manager.GetCatalog()
	categories := catalog.GetCategories()

	JSON(w, http.StatusOK, map[string]interface{}{
		"categories": categories,
	})
}

// RefreshCatalog handles POST /api/catalog/refresh
// Reloads the catalog from disk
func (h *CatalogHandler) RefreshCatalog(w http.ResponseWriter, r *http.Request) {
	if err := h.manager.RefreshCatalog(); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to refresh catalog: "+err.Error())
		return
	}

	catalog := h.manager.GetCatalog()
	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "catalog refreshed",
		"count":   catalog.Count(),
	})
}
