package handlers

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/services"
)

// ProvisionHandler handles service provisioning and plan info.
type ProvisionHandler struct {
	db  *sql.DB
	svc *services.ProvisioningService
}

func NewProvisionHandler(db *sql.DB) *ProvisionHandler {
	return &ProvisionHandler{db: db, svc: services.NewProvisioningService(db)}
}

// Info returns the public plan catalog.
func (h *ProvisionHandler) Info(w http.ResponseWriter, r *http.Request) {
	plans := catalog.Plans()
	result := make([]map[string]any, 0, len(plans))
	for _, p := range plans {
		result = append(result, map[string]any{
			"id":            p.ID,
			"name":          p.Name,
			"description":   p.Description,
			"price_monthly": p.PriceMonthlyCents,
		})
	}

	planLimits := map[string]map[string]any{}
	for _, p := range plans {
		l := p.Limits
		planLimits[p.ID] = map[string]any{
			"max_emails_per_day": func() int {
				if l.SMTPMonthly > 0 {
					return l.SMTPMonthly
				}
				return 0
			}(),
			"tunnel_gb_per_mo":    l.TunnelGBPerMo,
			"backup_gb":           l.BackupGB,
			"ai_messages_per_day": l.AIMessagesPerDay, // 0 = no message cap (credit-based plans)
			"ai_credit_cents":     l.AICreditCents,
			"domain":              l.Domain,
			"human_support":       l.HumanSupport,
		}
	}

	JSON(w, http.StatusOK, map[string]any{
		"plans":       result,
		"plan_limits": planLimits,
	})
}

// Provision generates credentials for a single service.
func (h *ProvisionHandler) Provision(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Service string `json:"service"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	deviceID := middleware.GetDeviceID(r.Context())
	if deviceID == "" {
		JSONError(w, http.StatusUnauthorized, "device authentication required")
		return
	}

	creds, err := h.svc.Provision(deviceID, req.Service, clientIPFromRequest(r))
	if err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	JSON(w, http.StatusOK, creds)
}

// RegisterRoute adds a public hostname to the device's tunnel.
// Called by the device when installing an app — creates a DNS CNAME and
// tunnel ingress rule so the app is reachable at its subdomain.
func (h *ProvisionHandler) RegisterRoute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Hostname string `json:"hostname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Hostname == "" {
		JSONError(w, http.StatusBadRequest, "hostname is required")
		return
	}

	deviceID := middleware.GetDeviceID(r.Context())
	if deviceID == "" {
		JSONError(w, http.StatusUnauthorized, "device authentication required")
		return
	}

	if err := h.svc.RegisterRoute(deviceID, req.Hostname); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"hostname": req.Hostname,
		"status":   "active",
	})
}

// UnregisterRoute removes a public hostname from the device's tunnel.
// Called by the device when removing an app.
func (h *ProvisionHandler) UnregisterRoute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Hostname string `json:"hostname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Hostname == "" {
		JSONError(w, http.StatusBadRequest, "hostname is required")
		return
	}

	deviceID := middleware.GetDeviceID(r.Context())
	if deviceID == "" {
		JSONError(w, http.StatusUnauthorized, "device authentication required")
		return
	}

	if err := h.svc.UnregisterRoute(deviceID, req.Hostname); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"hostname": req.Hostname,
		"status":   "removed",
	})
}

// DeleteTunnel removes the device's Cloudflare tunnel and its credentials.
// POST /api/v1/tunnel/delete (device auth). Called by LibreServ when an admin
// disables or deletes the tunnel.
func (h *ProvisionHandler) DeleteTunnel(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	if deviceID == "" {
		JSONError(w, http.StatusUnauthorized, "device authentication required")
		return
	}

	if err := h.svc.Revoke(deviceID, "tunnel"); err != nil {
		slog.Error("could not delete tunnel", "device_id", deviceID, "error", err)
		JSONError(w, http.StatusInternalServerError, "could not delete the tunnel")
		return
	}

	JSON(w, http.StatusOK, map[string]any{"status": "deleted"})
}

// clientIPFromRequest returns the client's IP without the port.
func clientIPFromRequest(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
