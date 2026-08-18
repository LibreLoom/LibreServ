package handlers

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"time"

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
		JSONError(w, http.StatusInternalServerError, "We couldn't load the network status. Please try again.")
		return
	}

	JSON(w, http.StatusOK, status)
}

// ListRoutes returns all configured routes
// GET /api/network/routes
func (h *NetworkHandlers) ListRoutes(w http.ResponseWriter, r *http.Request) {
	routes := h.caddyManager.ListRoutes()

	JSON(w, http.StatusOK, map[string]interface{}{
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
		JSONError(w, http.StatusBadRequest, "Please choose a route.")
		return
	}

	route, err := h.caddyManager.GetRoute(routeID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that route.")
		return
	}

	JSON(w, http.StatusOK, route)
}

// CheckRouteAvailability checks whether a subdomain+domain is free
// POST /api/network/routes/check
func (h *NetworkHandlers) CheckRouteAvailability(w http.ResponseWriter, r *http.Request) {
	if !h.checkLimiter.Allow() {
		w.Header().Set("Retry-After", "1")
		JSONError(w, http.StatusTooManyRequests, "You're doing that too quickly. Please wait a moment and try again.")
		return
	}
	var req CheckRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.Subdomain == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a subdomain.")
		return
	}
	available := h.caddyManager.IsDomainAvailable(req.Subdomain, req.Domain)
	domain := req.Domain
	if domain == "" {
		domain = h.caddyManager.Config().DefaultDomain
	}
	full := req.Subdomain + "." + domain
	JSON(w, http.StatusOK, map[string]interface{}{
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
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Subdomain == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a subdomain.")
		return
	}

	if !h.caddyManager.IsDomainAvailable(req.Subdomain, req.Domain) {
		full := req.Subdomain
		if req.Domain != "" {
			full = full + "." + req.Domain
		}
		JSONError(w, http.StatusConflict, "A route for "+full+" already exists.")
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
		JSONError(w, http.StatusBadRequest, "Please choose an app or enter a destination address for this route.")
		return
	}

	route, err := h.caddyManager.AddRoute(r.Context(), req.Subdomain, req.Domain, backend, req.AppID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't create the route. Please try again.")
		return
	}

	// Optionally enqueue ACME auto-issuance (persisted as a job) if email is configured.
	// This avoids "fire-and-forget" issuance where errors are silently lost.
	if h.acmeHandler != nil && h.acmeHandler.manager != nil {
		email := ""
		if h.caddyManager != nil {
			email = h.caddyManager.Config().Email
		}
		if email == "" {
			goto respond
		}
		// Best-effort: request a certificate job for the new domain.
		go func(domain string) {
			// NOTE: We intentionally do not block route creation on issuance.
			// Admins can query /api/v1/network/acme/status?domain=... for results.
			// Detach from the request context so cancellation mid-request does not
			// drop the persisted job, and bound the enqueue with a timeout.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Minute)
			defer cancel()
			_, _ = h.acmeHandler.EnqueueIssue(ctx, domain, email)
		}(route.FullDomain())
	}

respond:
	JSON(w, http.StatusCreated, route)
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
		JSONError(w, http.StatusBadRequest, "Please choose a route.")
		return
	}

	var req UpdateRouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	route, err := h.caddyManager.UpdateRoute(r.Context(), routeID, req.Backend, req.Enabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't update the route. Please try again.")
		return
	}

	JSON(w, http.StatusOK, route)
}

// DeleteRoute removes a route
// DELETE /api/network/routes/{routeID}
func (h *NetworkHandlers) DeleteRoute(w http.ResponseWriter, r *http.Request) {
	routeID := chi.URLParam(r, "routeID")
	if routeID == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a route.")
		return
	}

	if err := h.caddyManager.RemoveRoute(r.Context(), routeID); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't delete the route. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":  "deleted",
		"message": "Route deleted successfully",
	})
}

// GetCaddyfile returns the current Caddyfile content
// GET /api/network/caddyfile
func (h *NetworkHandlers) GetCaddyfile(w http.ResponseWriter, r *http.Request) {
	content, err := h.caddyManager.GetCaddyfileContent()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load the routing configuration. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
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
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Backend == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a destination address for the route.")
		return
	}

	err := h.caddyManager.TestBackend(req.Backend)
	if err != nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"reachable": false,
			"error":     err.Error(),
		})
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"reachable": true,
		"message":   "Backend is reachable",
	})
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
		Suggestions:   []string{},
	}

	status.Suggestions = append(status.Suggestions, "Forward ports 80 and 443 from your router to this device's IP")

	JSON(w, http.StatusOK, status)
}

// DisconnectDomain handles disconnecting the current domain
// POST /api/v1/network/domain/disconnect
func (h *NetworkHandlers) DisconnectDomain(w http.ResponseWriter, r *http.Request) {
	if h.caddyManager == nil {
		JSONError(w, http.StatusInternalServerError, "Network routing isn't set up yet.")
		return
	}

	cfg := h.caddyManager.Config()
	oldDomain := cfg.DefaultDomain

	if oldDomain == "" {
		JSON(w, http.StatusOK, map[string]string{
			"message": "No domain connected",
		})
		return
	}

	if err := h.caddyManager.UpdateDefaults("", cfg.Email, cfg.AutoHTTPS); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't disconnect the domain. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "Domain disconnected",
		"domain":  oldDomain,
	})
}
