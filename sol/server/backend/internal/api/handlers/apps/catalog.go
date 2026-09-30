package apps

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

// Upper bound on cached icons: the map used to grow without limit and pin
// every catalog icon in memory for up to an hour.
const iconCacheMaxEntries = 256

type iconCacheEntry struct {
	data        []byte
	contentType string
	expiresAt   time.Time
}

var iconCache = struct {
	sync.RWMutex
	entries map[string]*iconCacheEntry
	// Least-recently-used first: mirrors entries keys for bounded eviction.
	order []string
}{
	entries: make(map[string]*iconCacheEntry),
}

// ClearIconCache invalidates all cached app icons so that updated icons
// from a repo pull are served on the next request.
func ClearIconCache() {
	iconCache.Lock()
	iconCache.entries = make(map[string]*iconCacheEntry)
	iconCache.order = nil
	iconCache.Unlock()
}

// touchIconCacheLocked marks id as most-recently-used. Call with iconCache held.
func touchIconCacheLocked(id string) {
	for i, old := range iconCache.order {
		if old == id {
			iconCache.order = append(iconCache.order[:i], iconCache.order[i+1:]...)
			break
		}
	}
	iconCache.order = append(iconCache.order, id)
}

// evictIconCacheLocked keeps the icon cache bounded with LRU eviction.
// Call with iconCache held.
func evictIconCacheLocked() {
	if len(iconCache.entries) <= iconCacheMaxEntries {
		return
	}
	now := time.Now()
	for id, e := range iconCache.entries {
		if now.After(e.expiresAt) {
			delete(iconCache.entries, id)
		}
	}
	// Still over budget: evict least-recently-used first. Icons are
	// re-read from disk on demand, so this only costs a re-read, never
	// correctness.
	for len(iconCache.entries) > iconCacheMaxEntries && len(iconCache.order) > 0 {
		oldest := iconCache.order[0]
		iconCache.order = iconCache.order[1:]
		delete(iconCache.entries, oldest)
	}
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
		JSONError(w, http.StatusBadRequest, "Please choose an app.")
		return
	}

	catalog := h.manager.GetCatalog()
	app, err := catalog.GetApp(appID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app in the catalog.")
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

func (h *CatalogHandler) GetAppFeatures(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appId")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose an app.")
		return
	}

	catalog := h.manager.GetCatalog()
	app, err := catalog.GetApp(appID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app in the catalog.")
		return
	}

	model := app.AccessModel
	if model == "" {
		model = apps.AccessModelInternal
	}

	JSON(w, http.StatusOK, map[string]string{"access_model": string(model)})
}

func (h *CatalogHandler) GetAppIcon(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appId")
	if appID == "" {
		http.Error(w, "Please choose an app.", http.StatusBadRequest)
		return
	}

	iconCache.Lock()
	cached, exists := iconCache.entries[appID]
	if exists && time.Now().Before(cached.expiresAt) {
		touchIconCacheLocked(appID)
	}
	iconCache.Unlock()

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
	// #nosec G304 -- app.CatalogPath is verified from the system catalog list
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
	touchIconCacheLocked(appID)
	evictIconCacheLocked()
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
