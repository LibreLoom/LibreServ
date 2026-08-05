package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// MappingHandler exposes UPnP port-mapping CRUD and tunnel config export.
// This is the Advanced-section API: manual mappings for users who need
// direct control, plus the config-export escape hatch (FRP / WireGuard).
type MappingHandler struct {
	upnp *network.UPnPClient
}

func NewMappingHandler(upnp *network.UPnPClient) *MappingHandler {
	return &MappingHandler{upnp: upnp}
}

// GetStatus returns the current UPnP discovery status + mappings.
func (h *MappingHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.upnp.Status(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't check your router's UPnP settings right now.")
		return
	}
	if status == nil {
		JSON(w, http.StatusOK, map[string]any{"available": false, "enabled": false})
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"available":    status.Discovered,
		"enabled":      status.Enabled,
		"router_make":  status.RouterMake,
		"router_model": status.RouterModel,
		"external_ip":  status.WANIP,
		"mappings":     status.Mappings,
	})
}

// createMappingRequest is the manual port-forward payload.
type createMappingRequest struct {
	Protocol     string `json:"protocol"` // "tcp" | "udp"
	ExternalPort int    `json:"external_port"`
	InternalPort int    `json:"internal_port"`
	Description  string `json:"description"`
}

// CreateMapping adds a port mapping via UPnP.
func (h *MappingHandler) CreateMapping(w http.ResponseWriter, r *http.Request) {
	var req createMappingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.ExternalPort < 1 || req.ExternalPort > 65535 || req.InternalPort < 1 || req.InternalPort > 65535 {
		JSONError(w, http.StatusBadRequest, "Ports must be between 1 and 65535.")
		return
	}
	proto := strings.ToLower(req.Protocol)
	if proto == "" {
		proto = "tcp"
	}
	if proto != "tcp" && proto != "udp" {
		JSONError(w, http.StatusBadRequest, "Protocol must be tcp or udp.")
		return
	}
	if req.Description == "" {
		req.Description = "LibreServ"
	}

	mapping, err := h.upnp.AddMapping(r.Context(), proto, uint16(req.ExternalPort), uint16(req.InternalPort), req.Description)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't open that port on your router. UPnP may be disabled, or the port may already be in use.")
		return
	}
	if mapping == nil {
		JSONError(w, http.StatusServiceUnavailable, "Your router doesn't support UPnP port forwarding.")
		return
	}
	JSON(w, http.StatusCreated, mapping)
}

// DeleteMapping removes a port mapping.
func (h *MappingHandler) DeleteMapping(w http.ResponseWriter, r *http.Request) {
	proto := r.URL.Query().Get("protocol")
	portStr := r.URL.Query().Get("port")
	if proto == "" {
		proto = "tcp"
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		JSONError(w, http.StatusBadRequest, "A valid port is required.")
		return
	}
	if err := h.upnp.DeleteMapping(r.Context(), proto, uint16(port)); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't remove that port mapping. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// exportRequest selects what to export.
type exportRequest struct {
	Type string `json:"type"` // "frp" | "wireguard"
	// FRP relay details (for BYO FRP / self-hosted relay config export).
	Server   string `json:"server,omitempty"`
	Token    string `json:"token,omitempty"`
	Ports    []int  `json:"ports,omitempty"`
	Protocol string `json:"protocol,omitempty"` // "tcp" | "udp" | "both"
}

// ExportConfig returns a ready-to-paste configuration for the chosen relay
// type — the advanced escape hatch for users who run their own VPS.
func (h *MappingHandler) ExportConfig(w http.ResponseWriter, r *http.Request) {
	var req exportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request.")
		return
	}
	if req.Type == "" {
		req.Type = "frp"
	}

	switch req.Type {
	case "frp":
		if req.Server == "" {
			JSONError(w, http.StatusBadRequest, "A relay server address is required for FRP export.")
			return
		}
		cfg := buildFRPExport(req)
		JSON(w, http.StatusOK, map[string]string{"config": cfg, "type": "frp"})
	case "wireguard":
		cfg := buildWireGuardExport(req)
		JSON(w, http.StatusOK, map[string]string{"config": cfg, "type": "wireguard"})
	default:
		JSONError(w, http.StatusBadRequest, "Unknown export type. Use 'frp' or 'wireguard'.")
	}
}

// buildFRPExport renders an frpc.toml for the requested ports.
func buildFRPExport(req exportRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "serverAddr = %q\n", req.Server)
	if req.Token != "" {
		b.WriteString("auth.method = \"token\"\n")
		fmt.Fprintf(&b, "auth.token = %q\n", req.Token)
	}
	proto := req.Protocol
	if proto == "" {
		proto = "tcp"
	}
	for i, port := range req.Ports {
		fmt.Fprintf(&b, "\n[[proxies]]\n")
		fmt.Fprintf(&b, "name = %q\n", fmt.Sprintf("libreserv-%d", port))
		fmt.Fprintf(&b, "type = %q\n", proto)
		fmt.Fprintf(&b, "localPort = %d\n", port)
		fmt.Fprintf(&b, "remotePort = %d\n", port)
		_ = i
	}
	return b.String()
}

// buildWireGuardExport renders a WG client config stub (advanced escape
// hatch for users with their own mesh; the tunnel server side is out of scope).
func buildWireGuardExport(req exportRequest) string {
	var b strings.Builder
	b.WriteString("# LibreServ WireGuard relay export\n")
	b.WriteString("# Complete the endpoint and keys from your relay server.\n")
	b.WriteString("[Interface]\n")
	b.WriteString("Address = 10.13.37.2/32\n")
	b.WriteString("# PrivateKey = <your-client-private-key>\n\n")
	b.WriteString("[Peer]\n")
	b.WriteString("# Endpoint = <relay-server-ip>:51820\n")
	b.WriteString("# PublicKey = <relay-server-public-key>\n")
	b.WriteString("# AllowedIPs = 10.13.37.0/24\n")
	if len(req.Ports) > 0 {
		fmt.Fprintf(&b, "# Forwarded ports: %s\n", joinInts(req.Ports))
	}
	return b.String()
}

func joinInts(ports []int) string {
	parts := make([]string, 0, len(ports))
	for _, p := range ports {
		parts = append(parts, strconv.Itoa(p))
	}
	return strings.Join(parts, ", ")
}
