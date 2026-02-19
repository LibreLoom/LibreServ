package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/pagination"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
)

const iconCacheTTL = 1 * time.Hour

type iconCacheEntry struct {
	data        []byte
	contentType string
	expiresAt   time.Time
}

var iconCache = struct {
	sync.RWMutex
	entries map[string]*iconCacheEntry
}{
	entries: make(map[string]*iconCacheEntry),
}

type CatalogHandler struct {
	manager *apps.Manager
}

func NewCatalogHandler(manager *apps.Manager) *CatalogHandler {
	return &CatalogHandler{
		manager: manager,
	}
}

type CatalogListResponse struct {
	Apps       []*apps.AppDefinition `json:"apps"`
	Categories []apps.AppCategory    `json:"categories"`
	Pagination pagination.Metadata   `json:"pagination"`
}

func (h *CatalogHandler) ListApps(w http.ResponseWriter, r *http.Request) {
	params := pagination.FromRequest(r)

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

func (h *CatalogHandler) GetCategories(w http.ResponseWriter, r *http.Request) {
	catalog := h.manager.GetCatalog()
	categories := catalog.GetCategories()

	JSON(w, http.StatusOK, map[string]interface{}{
		"categories": categories,
	})
}

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

func (h *CatalogHandler) GetAppFeatures(w http.ResponseWriter, r *http.Request) {
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

	features := app.Features
	if features.AccessModel == "" {
		features = apps.GetDefaultFeatures()
	}

	JSON(w, http.StatusOK, features)
}

func (h *CatalogHandler) GetAppIcon(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appId")
	if appID == "" {
		http.Error(w, "app ID is required", http.StatusBadRequest)
		return
	}

	iconCache.RLock()
	cached, exists := iconCache.entries[appID]
	iconCache.RUnlock()

	if exists && time.Now().Before(cached.expiresAt) {
		w.Header().Set("Content-Type", cached.contentType)
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Write(cached.data)
		return
	}

	catalog := h.manager.GetCatalog()
	app, err := catalog.GetApp(appID)
	if err != nil {
		h.serveFallback(w, appID)
		return
	}

	iconPath := filepath.Join(app.CatalogPath, "icon.svg")
	svgData, err := os.ReadFile(iconPath)
	if err != nil {
		h.serveFallback(w, appID)
		return
	}

	svg := string(svgData)
	svg = strings.Replace(svg, "<svg", `<svg fill="currentColor"`, 1)

	iconCache.Lock()
	iconCache.entries[appID] = &iconCacheEntry{
		data:        []byte(svg),
		contentType: "image/svg+xml",
		expiresAt:   time.Now().Add(iconCacheTTL),
	}
	iconCache.Unlock()

	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write([]byte(svg))
}

func (h *CatalogHandler) serveFallback(w http.ResponseWriter, appID string) {
	firstLetter := strings.ToUpper(string(appID[0]))
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
		<rect width="128" height="128" rx="24" fill="currentColor" opacity="0.2"/>
		<text x="64" y="80" text-anchor="middle" font-family="monospace" font-size="56" font-weight="bold" fill="currentColor">` + firstLetter + `</text>
	</svg>`

	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write([]byte(svg))
}
