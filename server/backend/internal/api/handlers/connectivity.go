package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

type ConnectivityHandler struct {
	ipMonitor    *network.DDNSService
	upnpService  *network.UPnPService
	appManager   *apps.Manager
	caddyManager *network.CaddyManager
}

func NewConnectivityHandler(
	ipMonitor *network.DDNSService,
	upnpService *network.UPnPService,
	appManager *apps.Manager,
	caddyManager *network.CaddyManager,
) *ConnectivityHandler {
	return &ConnectivityHandler{
		ipMonitor:    ipMonitor,
		upnpService:  upnpService,
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
	UPnP         UPnPStatusSimple   `json:"upnp"`
	DDNS         DDNSStatusSimple   `json:"ddns"`
	Tunnel       TunnelStatusSimple `json:"tunnel"`
	Suggestions  []string           `json:"suggestions"`
}

type DomainStatus struct {
	Configured bool   `json:"configured"`
	Domain     string `json:"domain,omitempty"`
	HTTPS      bool   `json:"https"`
}

type UPnPStatusSimple struct {
	Available  bool   `json:"available"`
	Enabled    bool   `json:"enabled"`
	ExternalIP string `json:"external_ip,omitempty"`
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

	if h.upnpService != nil {
		upnpStatus := h.upnpService.GetStatus()
		resp.UPnP = UPnPStatusSimple{
			Available:  upnpStatus.Available,
			Enabled:    upnpStatus.Enabled,
			ExternalIP: upnpStatus.ExternalIP,
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
		if resp.UPnP.Enabled {
			return "degraded"
		}
		return "local_only"
	case "full_cone", "restricted", "port_restricted":
		if resp.UPnP.Enabled {
			return "degraded"
		}
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
	} else if !resp.UPnP.Enabled && resp.UPnP.Available {
		suggestions = append(suggestions, "Enable UPnP for automatic port forwarding")
	}

	if resp.DDNS.Running && resp.DDNS.CurrentIP != "" {
		suggestions = append(suggestions, "IP monitoring active - current IP: "+resp.DDNS.CurrentIP)
	}

	return suggestions
}
