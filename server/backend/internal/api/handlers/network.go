package handlers

import (
	"encoding/json"
	"net"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// NetworkHandlers handles network-related API endpoints
type NetworkHandlers struct {
	caddyManager *network.CaddyManager
	appManager   *apps.Manager
	checkLimiter *middleware.LeakyBucket
	acmeHandler  *ACMEHandler
}

// NewNetworkHandlers creates new network handlers
func NewNetworkHandlers(caddyManager *network.CaddyManager, appManager *apps.Manager) *NetworkHandlers {
	return &NetworkHandlers{
		caddyManager: caddyManager,
		appManager:   appManager,
		checkLimiter: middleware.NewLeakyBucket(10, 30), // allow light bursts for typeahead checks
		acmeHandler:  nil,
	}
}

// WithACME allows injecting ACME handler for auto-issuance.
func (h *NetworkHandlers) WithACME(acme *ACMEHandler) *NetworkHandlers {
	h.acmeHandler = acme
	return h
}

// GetCaddyStatus returns the current Caddy status
// GET /api/network/status
func (h *NetworkHandlers) GetCaddyStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.caddyManager.GetStatus(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// ListRoutes returns all configured routes
// GET /api/network/routes
func (h *NetworkHandlers) ListRoutes(w http.ResponseWriter, r *http.Request) {
	routes := h.caddyManager.ListRoutes()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"routes": routes,
		"count":  len(routes),
	})
}

func detectExternalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	local := conn.LocalAddr().(*net.UDPAddr)
	return local.IP.String()
}

// GetRoute returns a specific route
// GET /api/network/routes/{routeID}
func (h *NetworkHandlers) GetRoute(w http.ResponseWriter, r *http.Request) {
	routeID := chi.URLParam(r, "routeID")
	if routeID == "" {
		JSONError(w, http.StatusBadRequest, "route ID required")
		return
	}

	route, err := h.caddyManager.GetRoute(routeID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(route)
}

// CheckRouteAvailability checks whether a subdomain+domain is free
// POST /api/network/routes/check
func (h *NetworkHandlers) CheckRouteAvailability(w http.ResponseWriter, r *http.Request) {
	if !h.checkLimiter.Allow() {
		w.Header().Set("Retry-After", "1")
		JSONError(w, http.StatusTooManyRequests, "slow down")
		return
	}
	var req CheckRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Subdomain == "" {
		JSONError(w, http.StatusBadRequest, "subdomain is required")
		return
	}
	available := h.caddyManager.IsDomainAvailable(req.Subdomain, req.Domain)
	domain := req.Domain
	if domain == "" {
		domain = h.caddyManager.Config().DefaultDomain
	}
	full := req.Subdomain + "." + domain
	json.NewEncoder(w).Encode(map[string]interface{}{
		"available":  available,
		"fullDomain": full,
	})
}

// CreateRouteRequest is the request body for creating a route
type CreateRouteRequest struct {
	Subdomain    string `json:"subdomain"`
	Domain       string `json:"domain,omitempty"`  // optional override; defaults to configured base domain
	Backend      string `json:"backend,omitempty"` // optional if app_id provided
	AppID        string `json:"app_id,omitempty"`
	BackendName  string `json:"backend_name,omitempty"`  // optional logical backend (ui/api/admin)
	BackendIndex int    `json:"backend_index,omitempty"` // optional backend index
}

// CheckRouteRequest is the request body for availability check
type CheckRouteRequest struct {
	Subdomain string `json:"subdomain"`
	Domain    string `json:"domain,omitempty"`
}

// CreateRoute creates a new route
// POST /api/network/routes
func (h *NetworkHandlers) CreateRoute(w http.ResponseWriter, r *http.Request) {
	var req CreateRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Subdomain == "" {
		JSONError(w, http.StatusBadRequest, "subdomain is required")
		return
	}

	if !h.caddyManager.IsDomainAvailable(req.Subdomain, req.Domain) {
		full := req.Subdomain
		if req.Domain != "" {
			full = full + "." + req.Domain
		}
		JSONError(w, http.StatusConflict, "route already exists for "+full)
		return
	}

	backend := req.Backend
	if backend == "" && req.AppID != "" && h.appManager != nil {
		if req.BackendName != "" {
			backend = h.appManager.GetBackendByName(req.AppID, req.BackendName)
		}
		if backend == "" && req.BackendIndex > 0 {
			backend = h.appManager.GetBackendByIndex(req.AppID, req.BackendIndex)
		}
		if backend == "" {
			backend = h.appManager.GetBackendURL(req.AppID)
		}
	}

	if backend == "" {
		JSONError(w, http.StatusBadRequest, "backend is required (provide backend or app_id with a resolvable backend)")
		return
	}

	route, err := h.caddyManager.AddRoute(r.Context(), req.Subdomain, req.Domain, backend, req.AppID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Optionally trigger ACME auto-issuance if available
	if h.acmeHandler != nil && h.acmeHandler.manager != nil {
		go func(domain string) {
			_ = h.acmeHandler.manager.Issue(r.Context(), network.ACMERequest{
				Domain: domain,
				Email:  "",
			})
		}(route.FullDomain())
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(route)
}

// UpdateRouteRequest is the request body for updating a route
type UpdateRouteRequest struct {
	Backend string `json:"backend"`
	Enabled bool   `json:"enabled"`
}

// UpdateRoute updates an existing route
// PUT /api/network/routes/{routeID}
func (h *NetworkHandlers) UpdateRoute(w http.ResponseWriter, r *http.Request) {
	routeID := chi.URLParam(r, "routeID")
	if routeID == "" {
		JSONError(w, http.StatusBadRequest, "route ID required")
		return
	}

	var req UpdateRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	route, err := h.caddyManager.UpdateRoute(r.Context(), routeID, req.Backend, req.Enabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(route)
}

// DeleteRoute removes a route
// DELETE /api/network/routes/{routeID}
func (h *NetworkHandlers) DeleteRoute(w http.ResponseWriter, r *http.Request) {
	routeID := chi.URLParam(r, "routeID")
	if routeID == "" {
		JSONError(w, http.StatusBadRequest, "route ID required")
		return
	}

	if err := h.caddyManager.RemoveRoute(r.Context(), routeID); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "deleted",
		"message": "Route deleted successfully",
	})
}

// GetCaddyfile returns the current Caddyfile content
// GET /api/network/caddyfile
func (h *NetworkHandlers) GetCaddyfile(w http.ResponseWriter, r *http.Request) {
	content, err := h.caddyManager.GetCaddyfileContent()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"content": content,
	})
}

// TestBackendRequest is the request body for testing a backend
type TestBackendRequest struct {
	Backend string `json:"backend"`
}

// TestBackend tests if a backend is reachable
// POST /api/network/test-backend
func (h *NetworkHandlers) TestBackend(w http.ResponseWriter, r *http.Request) {
	var req TestBackendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Backend == "" {
		JSONError(w, http.StatusBadRequest, "backend URL is required")
		return
	}

	err := h.caddyManager.TestBackend(req.Backend)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"reachable": false,
			"error":     err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"reachable": true,
		"message":   "Backend is reachable",
	})
}

// GetRouteByApp returns the route for a specific app
// GET /api/apps/{appID}/route
func (h *NetworkHandlers) GetRouteByApp(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	if appID == "" {
		JSONError(w, http.StatusBadRequest, "app ID required")
		return
	}

	route, err := h.caddyManager.GetRouteByApp(appID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(route)
}

// ConfigureDomainRequest is the request body for domain configuration
type ConfigureDomainRequest struct {
	DefaultDomain string `json:"default_domain"`
	SSLEmail      string `json:"ssl_email"`
	AutoHTTPS     bool   `json:"auto_https"`
}

// ConfigureDomain updates the default domain configuration
// POST /api/v1/network/domain
func (h *NetworkHandlers) ConfigureDomain(w http.ResponseWriter, r *http.Request) {
	var req ConfigureDomainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// TODO: Update Caddy configuration with new domain settings
	// For now, just return success
	JSON(w, http.StatusOK, map[string]string{
		"status":  "configured",
		"message": "Domain configuration updated",
	})
}

// GetDomainConfig returns the current domain configuration
// GET /api/v1/network/domain
func (h *NetworkHandlers) GetDomainConfig(w http.ResponseWriter, r *http.Request) {
	// TODO: Return actual domain configuration from Caddy config
	// For now, return default configuration
	config := map[string]interface{}{
		"default_domain": "",
		"ssl_email":      "",
		"auto_https":     true,
	}

	JSON(w, http.StatusOK, config)
}

// PortForwardingStatus represents the port forwarding status
type PortForwardingStatus struct {
	ExternalIP    string   `json:"external_ip"`
	RequiredPorts []int    `json:"required_ports"`
	IsConfigured  bool     `json:"is_configured"`
	Suggestions   []string `json:"suggestions"`
}

// GetPortForwardingStatus returns the current port forwarding status
// GET /api/v1/network/port-forwarding-status
func (h *NetworkHandlers) GetPortForwardingStatus(w http.ResponseWriter, r *http.Request) {
	ip := detectExternalIP()
	status := PortForwardingStatus{
		ExternalIP:    ip,
		RequiredPorts: []int{80, 443},
		IsConfigured:  ip != "",
		Suggestions: []string{
			"Forward ports 80 and 443 from your router to this device's IP",
		},
	}

	JSON(w, http.StatusOK, status)
}
