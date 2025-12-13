package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// ACMEHandler handles ACME/DNS probe flows (stub for now).
type ACMEHandler struct {
	manager      *network.ACMEManager
	caddyManager *network.CaddyManager
	routeIndex   map[string]string // domain -> routeID
	appBackends  map[string]string // appID -> backend
	appManager   *apps.Manager
}

func NewACMEHandler(manager *network.ACMEManager, caddyManager *network.CaddyManager, appManager *apps.Manager) *ACMEHandler {
	return &ACMEHandler{
		manager:      manager,
		caddyManager: caddyManager,
		routeIndex:   make(map[string]string),
		appBackends:  make(map[string]string),
		appManager:   appManager,
	}
}

// ProbeDNS handles POST /api/v1/network/acme/probe-dns { "host": "example.com" }
func (h *ACMEHandler) ProbeDNS(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host string `json:"host"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Host == "" {
		JSONError(w, http.StatusBadRequest, "host required")
		return
	}
	res, err := network.ResolveHostname(r.Context(), body.Host, 3*time.Second)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	JSON(w, http.StatusOK, res)
}

// ProbePorts handles POST /api/v1/network/acme/probe-ports { "host": "example.com", "ports": [80,443] }
func (h *ACMEHandler) ProbePorts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host  string `json:"host"`
		Ports []int  `json:"ports"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Host == "" || len(body.Ports) == 0 {
		JSONError(w, http.StatusBadRequest, "host and ports required")
		return
	}
	results := make([]*network.ProbeResult, 0, len(body.Ports))
	for _, p := range body.Ports {
		results = append(results, network.ProbeTCP(body.Host, p, 2*time.Second))
	}
	JSON(w, http.StatusOK, map[string]any{
		"host":    body.Host,
		"results": results,
	})
}

// RequestCert handles POST /api/v1/network/acme/request { "domain": "...", "email": "..." }
// Currently a stub that validates input and returns accepted; replace with real Caddy Admin API call.
func (h *ACMEHandler) RequestCert(w http.ResponseWriter, r *http.Request) {
	var body network.ACMERequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Domain == "" || body.Email == "" {
		JSONError(w, http.StatusBadRequest, "domain and email required")
		return
	}
	if h.manager == nil {
		JSONError(w, http.StatusInternalServerError, "acme manager not configured")
		return
	}
	backend := h.resolveBackend(body)
	if h.caddyManager != nil {
		// Avoid duplicate routes for the same domain
		if existingID, ok := h.routeIndex[body.Domain]; ok {
			_ = h.caddyManager.RemoveRoute(r.Context(), existingID)
			delete(h.routeIndex, body.Domain)
		}
		// Reuse existing domain route if present
		if _, ok := h.caddyManager.FindRouteByDomain(body.Domain); !ok {
			route, err := h.caddyManager.AddDomainRoute(r.Context(), body.Domain, backend, "acme-auto")
			if err != nil {
				JSONError(w, http.StatusInternalServerError, "failed to add route for domain: "+err.Error())
				return
			}
			h.routeIndex[body.Domain] = route.ID
		}
		// Ensure config applied after route addition
		if err := h.caddyManager.ApplyConfig(); err != nil {
			if id, ok := h.routeIndex[body.Domain]; ok {
				_ = h.caddyManager.RemoveRoute(r.Context(), id)
				delete(h.routeIndex, body.Domain)
			}
			JSONError(w, http.StatusInternalServerError, "failed to apply caddy config: "+err.Error())
			return
		}
	}
	if err := h.manager.Issue(r.Context(), body); err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	JSON(w, http.StatusAccepted, map[string]any{
		"message":  "ACME request accepted (stub; replace with Caddy Admin integration)",
		"domain":   body.Domain,
		"route_id": h.routeIndex[body.Domain],
		"backend":  backend,
	})
}
