package handlers

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/pagination"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
)

const (
	iconCacheTTL = 1 * time.Hour
)

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

// GetAppFeatures handles GET /api/catalog/{appId}/features
// Returns the feature matrix for a specific app
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

	// Use app features if defined (check AccessModel), otherwise return defaults
	features := app.Features
	if features.AccessModel == "" {
		features = apps.GetDefaultFeatures()
	}

	JSON(w, http.StatusOK, features)
}

// GetAppIcon handles GET /api/catalog/{appId}/icon
// Returns the app icon with caching and fallback support
func (h *CatalogHandler) GetAppIcon(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appId")
	if appID == "" {
		http.Error(w, "app ID is required", http.StatusBadRequest)
		return
	}

	catalog := h.manager.GetCatalog()
	app, err := catalog.GetApp(appID)
	if err != nil {
		h.serveFallback(w, appID)
		return
	}

	iconURL := app.Icon
	if iconURL == "" {
		h.serveFallback(w, appID)
		return
	}

	cacheKey := iconURL

	iconCache.RLock()
	cached, exists := iconCache.entries[cacheKey]
	iconCache.RUnlock()

	if exists && time.Now().Before(cached.expiresAt) {
		w.Header().Set("Content-Type", cached.contentType)
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Write(cached.data)
		return
	}

	iconData, contentType, err := fetchIcon(iconURL)
	if err != nil {
		h.serveFallback(w, appID)
		return
	}

	processedData, processedType := processIcon(iconData, contentType, appID)

	iconCache.Lock()
	iconCache.entries[cacheKey] = &iconCacheEntry{
		data:        processedData,
		contentType: processedType,
		expiresAt:   time.Now().Add(iconCacheTTL),
	}
	iconCache.Unlock()

	w.Header().Set("Content-Type", processedType)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(processedData)
}

func fetchIcon(url string) ([]byte, string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "", err
	}

	buf := make([]byte, 512*1024)
	n, _ := resp.Body.Read(buf)
	buf = buf[:n]

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/png"
	}

	return buf, contentType, nil
}

func processIcon(data []byte, contentType, appID string) ([]byte, string) {
	contentType = strings.TrimSpace(strings.Split(contentType, ";")[0])

	if contentType == "image/svg+xml" {
		processed := stripSVGColors(string(data))
		return []byte(processed), "image/svg+xml"
	}

	return createPlaceholderSVG(appID), "image/svg+xml"
}

func stripSVGColors(svg string) string {
	svg = strings.ReplaceAll(svg, `fill="`, `fill-value="`)
	svg = strings.ReplaceAll(svg, `stroke="`, `stroke-value="`)
	svg = strings.ReplaceAll(svg, `fill='`, `fill-value='`)
	svg = strings.ReplaceAll(svg, `stroke='`, `stroke-value='`)

	svg = strings.ReplaceAll(svg, `fill-value="`, `fill="`)
	svg = strings.ReplaceAll(svg, `stroke-value="`, `stroke="`)

	svg = stripAttr(svg, `fill="`, `"`)
	svg = stripAttr(svg, `stroke="`, `"`)
	svg = stripAttr(svg, `fill='`, `'`)
	svg = stripAttr(svg, `stroke='`, `'`)

	if !strings.Contains(svg, "currentColor") && !strings.Contains(svg, "<svg") {
		svg = `<svg fill="currentColor" ` + svg[4:]
	} else if !strings.Contains(svg, "fill=") && strings.Contains(svg, "<svg") {
		svg = strings.Replace(svg, "<svg", `<svg fill="currentColor"`, 1)
	}

	return svg
}

func stripAttr(s, prefix, suffix string) string {
	result := ""
	for i := 0; i < len(s); i++ {
		idx := strings.Index(s[i:], prefix)
		if idx == -1 {
			result += s[i:]
			break
		}
		result += s[i : i+idx]
		i += idx + len(prefix)
		endIdx := strings.Index(s[i:], suffix)
		if endIdx == -1 {
			break
		}
		i += endIdx
	}
	return result
}

func createPlaceholderSVG(appID string) []byte {
	firstLetter := strings.ToUpper(string(appID[0]))
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
		<rect width="128" height="128" rx="24" fill="currentColor" opacity="0.2"/>
		<text x="64" y="80" text-anchor="middle" font-family="monospace" font-size="56" font-weight="bold" fill="currentColor">` + firstLetter + `</text>
	</svg>`
	return []byte(svg)
}

func (h *CatalogHandler) serveFallback(w http.ResponseWriter, appID string) {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
		<rect width="128" height="128" rx="24" fill="currentColor" opacity="0.2"/>
		<text x="64" y="80" text-anchor="middle" font-family="monospace" font-size="56" font-weight="bold" fill="currentColor">` + strings.ToUpper(string(appID[0])) + `</text>
	</svg>`

	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write([]byte(svg))
}
