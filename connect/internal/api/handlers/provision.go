package handlers

import (
	"database/sql"
	"encoding/json"
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
			"limits":        p.Limits,
		})
	}

	JSON(w, http.StatusOK, map[string]any{
		"plans": result,
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

// clientIPFromRequest returns the client's IP without the port.
func clientIPFromRequest(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
