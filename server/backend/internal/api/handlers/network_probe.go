package handlers

import (
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// NetworkProbeHandler exposes DNS and TCP probes.
type NetworkProbeHandler struct{}

// NewNetworkProbeHandler creates a handler for network probe endpoints.
func NewNetworkProbeHandler() *NetworkProbeHandler { return &NetworkProbeHandler{} }

// DNS handles GET /api/v1/network/dns?host=example.com
func (h *NetworkProbeHandler) DNS(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	if host == "" {
		JSONError(w, http.StatusBadRequest, "Please provide the host to check.")
		return
	}
	if err := network.ValidateHost(host); err != nil {
		JSONError(w, http.StatusBadRequest, "Please enter a valid hostname.")
		return
	}
	res, err := network.ResolveHostname(r.Context(), host, 3*time.Second)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't look up the address for that domain.")
		return
	}
	for _, ipStr := range append(res.ARecords, res.AAAARecords...) {
		if ip := net.ParseIP(ipStr); ip != nil && network.IsBlockedIP(ip) {
			slog.Warn("Network probe target resolved to blocked IP", "host", host, "ip", ipStr)
			JSONError(w, http.StatusBadRequest, "That IP address isn't allowed.")
			return
		}
	}
	JSON(w, http.StatusOK, res)
}

// ProbeTCP handles GET /api/v1/network/probe?host=example.com&port=443
func (h *NetworkProbeHandler) ProbeTCP(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	portStr := r.URL.Query().Get("port")
	if host == "" || portStr == "" {
		JSONError(w, http.StatusBadRequest, "Please provide the host and port to check.")
		return
	}
	if err := network.ValidateHost(host); err != nil {
		JSONError(w, http.StatusBadRequest, "Please enter a valid hostname.")
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		JSONError(w, http.StatusBadRequest, "Please provide a valid port number.")
		return
	}

	ips, resolveErr := net.DefaultResolver.LookupIPAddr(r.Context(), host)
	if resolveErr == nil {
		for _, ipAddr := range ips {
			if network.IsBlockedIP(ipAddr.IP) {
				slog.Warn("Network TCP probe target resolved to blocked IP", "host", host, "ip", ipAddr.IP.String())
				JSONError(w, http.StatusBadRequest, "That IP address isn't allowed.")
				return
			}
		}
	}

	res := network.ProbeTCP(host, port, 2*time.Second)
	if !res.Reachable {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	JSON(w, http.StatusOK, res)
}
