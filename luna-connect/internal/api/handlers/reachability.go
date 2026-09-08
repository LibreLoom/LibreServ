package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
)

const lunaHealthProbeTimeout = 8 * time.Second

var lunaHealthHTTPClient = &http.Client{Timeout: lunaHealthProbeTimeout}

// probeLunaHealth checks whether Luna's public HTTPS health endpoint responds.
func probeLunaHealth(hostname string) bool {
	if hostname == "" {
		return false
	}
	resp, err := lunaHealthHTTPClient.Get("https://" + hostname + "/api/v1/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// probeDomainProvisioned checks whether DNS is propagated, SSL certificate is active on Cloudflare's
// edge, and the hostname reaches the Cloudflare tunnel ingress (returning Error 1033 / HTTP 530, or 200 if already up).
func probeDomainProvisioned(hostname string) bool {
	if hostname == "" {
		return false
	}
	resp, err := lunaHealthHTTPClient.Get("https://" + hostname + "/api/v1/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	// When Cloudflare tunnel CNAME and edge SSL cert are provisioned, but the daemon is not yet connected,
	// Cloudflare returns HTTP 530 (Error 1033). If the daemon is already connected and serving, it returns 200-299.
	// Any other error (DNS lookup failure, TLS handshake error) fails above at Get().
	return resp.StatusCode == http.StatusBadGateway ||
		resp.StatusCode == 530 ||
		(resp.StatusCode >= 200 && resp.StatusCode < 300)
}

// DeviceSetupReadiness reports whether Luna is online, provisioned, and reachable at its public address.
func (h AccountHandler) DeviceSetupReadiness(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	deviceID := chi.URLParam(r, "deviceID")
	var accountID string
	var sub, tunnelID string
	var lastSeen int64
	err := h.DB.QueryRow(
		`SELECT account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(last_seen_at,0) FROM devices WHERE id = ?`,
		deviceID,
	).Scan(&accountID, &sub, &tunnelID, &lastSeen)
	if err != nil || accountID != acct.ID {
		JSONError(w, http.StatusNotFound, "That Luna is not on this account.")
		return
	}
	now := time.Now().Unix()
	online := lastSeen > 0 && now-lastSeen <= OnlineWithinSec
	hasTunnel := tunnelID != ""
	hostname := ""
	if sub != "" {
		hostname = domainname.Hostname(sub, config.C.Server.PublicZone)
	}
	domainReady := false
	reachable := false
	if hostname != "" && online && hasTunnel {
		if config.DevMode() {
			domainReady = true
			reachable = probeLunaHealth(hostname)
		} else {
			domainReady = probeDomainProvisioned(hostname)
			if domainReady {
				reachable = probeLunaHealth(hostname)
			}
		}
	}
	ready := online && hasTunnel && domainReady && reachable
	JSON(w, http.StatusOK, map[string]any{
		"online":       online,
		"has_tunnel":   hasTunnel,
		"domain_ready": domainReady,
		"reachable":    reachable,
		"hostname":     hostname,
		"ready":        ready,
	})
}
