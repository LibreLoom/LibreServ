package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

type ConnectivityHandler struct {
	ipMonitor    *network.DDNSService
	appManager   *apps.Manager
	caddyManager *network.CaddyManager
}

func NewConnectivityHandler(
	ipMonitor *network.DDNSService,
	appManager *apps.Manager,
	caddyManager *network.CaddyManager,
) *ConnectivityHandler {
	return &ConnectivityHandler{
		ipMonitor:    ipMonitor,
		appManager:   appManager,
		caddyManager: caddyManager,
	}
}

type ConnectivityResponse struct {
	RemoteAccess string             `json:"remote_access"`
	NATType      string             `json:"nat_type"`
	PublicIP     string             `json:"public_ip"`
	LocalIP      string             `json:"local_ip"`
	Domain       DomainStatus       `json:"domain"`
	DDNS         DDNSStatusSimple   `json:"ddns"`
	Tunnel       TunnelStatusSimple `json:"tunnel"`
	Suggestions  []string           `json:"suggestions"`
}

type DomainStatus struct {
	Configured bool   `json:"configured"`
	Domain     string `json:"domain,omitempty"`
	HTTPS      bool   `json:"https"`
}

type DDNSStatusSimple struct {
	Running   bool   `json:"running"`
	CurrentIP string `json:"current_ip,omitempty"`
}

type TunnelStatusSimple struct {
	Available bool   `json:"available"`
	Enabled   bool   `json:"enabled"`
	URL       string `json:"url,omitempty"`
}

func (h *ConnectivityHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	natResult, _ := network.DetectNATType(ctx)

	resp := ConnectivityResponse{
		NATType:     "unknown",
		Suggestions: []string{},
	}

	if natResult != nil {
		resp.NATType = string(natResult.Type)
		resp.PublicIP = natResult.PublicIP.String()
		resp.LocalIP = natResult.LocalIP.String()
	}

	if h.ipMonitor != nil {
		ip, _, _ := h.ipMonitor.Status()
		resp.DDNS = DDNSStatusSimple{
			Running:   h.ipMonitor.IsRunning(),
			CurrentIP: ip,
		}
		if resp.PublicIP == "" && ip != "" {
			resp.PublicIP = ip
		}
	}

	if h.caddyManager != nil {
		cfg := h.caddyManager.Config()
		resp.Domain = DomainStatus{
			Configured: cfg.DefaultDomain != "",
			Domain:     cfg.DefaultDomain,
			HTTPS:      cfg.AutoHTTPS,
		}
	}

	resp.RemoteAccess = h.deriveRemoteAccess(resp)
	resp.Suggestions = h.generateSuggestions(resp)

	JSON(w, http.StatusOK, resp)
}

func (h *ConnectivityHandler) deriveRemoteAccess(resp ConnectivityResponse) string {
	if resp.Domain.Configured && resp.Domain.HTTPS {
		return "active"
	}

	if resp.Tunnel.Enabled {
		return "active"
	}

	switch resp.NATType {
	case "open":
		return "local_only"
	case "full_cone", "restricted", "port_restricted":
		return "local_only"
	case "symmetric", "cgnat", "blocked":
		return "blocked"
	default:
		return "local_only"
	}
}

func (h *ConnectivityHandler) generateSuggestions(resp ConnectivityResponse) []string {
	suggestions := []string{}

	if resp.RemoteAccess == "active" {
		suggestions = append(suggestions, "Remote access is working correctly")
		return suggestions
	}

	if !resp.Domain.Configured {
		suggestions = append(suggestions, "Set up a domain for secure remote access")
	}

	if resp.NATType == "cgnat" || resp.NATType == "symmetric" || resp.NATType == "blocked" {
		suggestions = append(suggestions, "Your network requires a tunnel for remote access")
	}

	if resp.DDNS.Running && resp.DDNS.CurrentIP != "" {
		suggestions = append(suggestions, "IP monitoring active - current IP: "+resp.DDNS.CurrentIP)
	}

	return suggestions
}
