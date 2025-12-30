package handlers

import (
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
		JSONError(w, http.StatusBadRequest, "host required")
		return
	}
	res, err := network.ResolveHostname(r.Context(), host, 3*time.Second)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	JSON(w, http.StatusOK, res)
}

// ProbeTCP handles GET /api/v1/network/probe?host=example.com&port=443
func (h *NetworkProbeHandler) ProbeTCP(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	portStr := r.URL.Query().Get("port")
	if host == "" || portStr == "" {
		JSONError(w, http.StatusBadRequest, "host and port required")
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		JSONError(w, http.StatusBadRequest, "invalid port")
		return
	}
	res := network.ProbeTCP(host, port, 2*time.Second)
	if !res.Reachable {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	JSON(w, http.StatusOK, res)
}
