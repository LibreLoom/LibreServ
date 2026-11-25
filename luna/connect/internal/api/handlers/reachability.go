package handlers

import (
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
)

// lunaHealthProbeTimeout bounds the one probe a setup-readiness poll makes. The
// page polls again, so a short wait beats holding the request open.
const lunaHealthProbeTimeout = 4 * time.Second

// lunaProbeTTL lets overlapping polls for one hostname share a single probe.
const lunaProbeTTL = 3 * time.Second

// lunaHealthHTTPClient probes customer hostnames. Never follow redirects: a Luna
// (or anything answering /api/v1/health) could 302 Connect into RFC1918 / metadata.
var lunaHealthHTTPClient = &http.Client{
	Timeout: lunaHealthProbeTimeout,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// probeLuna GETs Luna's public health endpoint once and reads both answers from
// the status code. provisioned: DNS, Cloudflare's edge certificate and the tunnel
// ingress are in place, so the edge answers 502 or 530 (Error 1033) until the
// daemon connects, or 2xx once it serves. healthy: Luna itself answered 2xx.
// DNS or TLS failures fail the Get, so both stay false.
func probeLuna(hostname string) (provisioned, healthy bool) {
	if hostname == "" {
		return false, false
	}
	resp, err := lunaHealthHTTPClient.Get("https://" + hostname + "/api/v1/health")
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	healthy = resp.StatusCode >= 200 && resp.StatusCode < 300
	provisioned = healthy || resp.StatusCode == http.StatusBadGateway || resp.StatusCode == 530
	return provisioned, healthy
}

// probeLunaHealth checks whether Luna's public HTTPS health endpoint responds.
func probeLunaHealth(hostname string) bool {
	_, healthy := probeLuna(hostname)
	return healthy
}

// probeDomainProvisioned checks whether the hostname reaches the Cloudflare tunnel ingress.
func probeDomainProvisioned(hostname string) bool {
	provisioned, _ := probeLuna(hostname)
	return provisioned
}

type lunaProbeResult struct {
	at                   time.Time
	provisioned, healthy bool
}

var (
	lunaProbeMu    sync.Mutex
	lunaProbeCache = map[string]lunaProbeResult{}
)

// probeLunaCached reuses a probe younger than lunaProbeTTL, so polling tabs and
// retries do not each send a request through the tunnel to the Luna.
func probeLunaCached(hostname string) (provisioned, healthy bool) {
	now := time.Now()
	lunaProbeMu.Lock()
	if c, ok := lunaProbeCache[hostname]; ok && now.Sub(c.at) < lunaProbeTTL {
		lunaProbeMu.Unlock()
		return c.provisioned, c.healthy
	}
	lunaProbeMu.Unlock()
	provisioned, healthy = probeLuna(hostname)
	lunaProbeMu.Lock()
	// Drop stale entries here so the map stays bounded by hostnames polled recently.
	for k, c := range lunaProbeCache {
		if now.Sub(c.at) >= lunaProbeTTL {
			delete(lunaProbeCache, k)
		}
	}
	lunaProbeCache[hostname] = lunaProbeResult{at: time.Now(), provisioned: provisioned, healthy: healthy}
	lunaProbeMu.Unlock()
	return provisioned, healthy
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
	var sub, tunnelID, state string
	var lastSeen int64
	err := h.DB.QueryRow(
		`SELECT account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(last_seen_at,0), COALESCE(state,'unbound') FROM devices WHERE id = ?`,
		deviceID,
	).Scan(&accountID, &sub, &tunnelID, &lastSeen, &state)
	if err != nil || accountID != acct.ID || state != "bound" {
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
		domainReady, reachable = probeLunaCached(hostname)
		if config.DevMode() {
			domainReady = true
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
