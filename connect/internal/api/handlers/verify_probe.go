package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
)

// VerifyProbeHandler answers reachability probes from LibreServ devices.
// It is the "verify from outside" source of truth for the device's network
// report: the device cannot grade its own homework, so Connect probes
// host:port from here (Hetzner edge).
//
// Abuse guards (per plan §5/register #17):
//   - Device auth required (a Connect account — free tier counts)
//   - Targets are bound to the device's own domains (subdomain or custom
//     domains registered in Connect); arbitrary targets are rejected
//   - IsBlockedIP-style guards (no RFC1918, link-local, CGNAT, metadata)
//   - Hard rate limit per device
type VerifyProbeHandler struct {
	db *sql.DB
	mu sync.Mutex
	// lastProbe tracks per-device probe timestamps for rate limiting.
	lastProbe map[string]time.Time
}

func NewVerifyProbeHandler(db *sql.DB) *VerifyProbeHandler {
	return &VerifyProbeHandler{
		db:        db,
		lastProbe: map[string]time.Time{},
	}
}

type verifyProbeRequest struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"` // "tcp" (default) | "udp"
}

type verifyProbeResponse struct {
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latency_ms,omitempty"`
	Error     string `json:"error,omitempty"`
}

const (
	verifyProbeRateLimit = 5 * time.Second // per device, between probes
	verifyProbeTimeout   = 4 * time.Second
	maxVerifyProbePort   = 65535
)

// Probe handles POST /api/v1/verify-probe.
func (h *VerifyProbeHandler) Probe(w http.ResponseWriter, r *http.Request) {
	deviceID := middleware.GetDeviceID(r.Context())
	if deviceID == "" {
		JSONError(w, http.StatusUnauthorized, "device authentication required")
		return
	}

	var req verifyProbeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Host == "" {
		JSONError(w, http.StatusBadRequest, "host required")
		return
	}
	if req.Port < 1 || req.Port > maxVerifyProbePort {
		JSONError(w, http.StatusBadRequest, "port out of range")
		return
	}
	proto := strings.ToLower(req.Protocol)
	if proto == "" {
		proto = "tcp"
	}
	if proto != "tcp" && proto != "udp" {
		JSONError(w, http.StatusBadRequest, "protocol must be tcp or udp")
		return
	}

	// Rate limit PER TARGET (device+host+port+proto), not per device: the
	// device's verify loop probes v4 443/80 and v6 443/80 back-to-back in one
	// tick — a per-device limit would 429 every probe after the first.
	// The map is capped so stale keys can't grow without bound.
	targetKey := deviceID + "|" + req.Host + "|" + strconv.Itoa(req.Port) + "|" + proto
	h.mu.Lock()
	last, ok := h.lastProbe[targetKey]
	now := time.Now()
	if ok && now.Sub(last) < verifyProbeRateLimit {
		h.mu.Unlock()
		JSONError(w, http.StatusTooManyRequests, "too many probes — try again in a moment")
		return
	}
	if len(h.lastProbe) >= 10000 {
		for k, v := range h.lastProbe {
			if now.Sub(v) > 10*time.Minute {
				delete(h.lastProbe, k)
			}
		}
	}
	h.lastProbe[targetKey] = now
	h.mu.Unlock()

	// Validate the target: the device may only probe its own addresses.
	// Resolve the host and require the result to be a public IP that
	// matches the device's own domain(s). The caller's egress IP (what
	// Connect sees the device connecting FROM) is passed through so IP
	// literals matching it are allowed.
	callerIP, _, _ := net.SplitHostPort(r.RemoteAddr)
	if err := h.validateTarget(r.Context(), deviceID, req.Host, callerIP); err != nil {
		JSONError(w, http.StatusForbidden, err.Error())
		return
	}

	start := time.Now()
	reachable := false
	switch proto {
	case "tcp":
		reachable = probeTCP(req.Host, req.Port)
	case "udp":
		// UDP has no connect(); an open UDP socket may still be silently
		// filtered. Full UDP verification needs the app-defined protocol
		// check (PortNeed.VerifyHint) — this is a best-effort read.
		reachable = probeUDP(req.Host, req.Port)
	}
	latency := time.Since(start)

	resp := verifyProbeResponse{Reachable: reachable, LatencyMS: latency.Milliseconds()}
	if !reachable {
		resp.Error = "no response"
	}
	JSON(w, http.StatusOK, resp)
}

// validateTarget checks the probe host is one of the device's own names and
// that every resolved IP is a public address (SSRF guard). Allowed names:
// the device's Connect subdomain, any `<app>-<subdomain>` flat pattern, and
// custom domains registered to it. The hostname is RESOLVED and every
// resulting IP is blocklist-checked — a device owner pointing a registered
// domain at a victim/private address must not turn Connect into a scanner.
func (h *VerifyProbeHandler) validateTarget(ctx context.Context, deviceID, host, callerIP string) error {
	// IP literals are allowed ONLY when they match the caller's egress IP —
	// the address Connect observed the device connecting from. The device's
	// verify loop probes its own public IP, so this is exactly "the device
	// may probe its own address". Blocklist-check regardless.
	if ip := net.ParseIP(host); ip != nil {
		if callerIP != "" && net.ParseIP(callerIP) != nil && ip.Equal(net.ParseIP(callerIP)) {
			if isBlockedIP(ip) {
				return errTargetNotAllowed()
			}
			return nil
		}
		return errTargetNotAllowed()
	}

	lower := strings.ToLower(strings.TrimSuffix(host, "."))

	// Hostname: must be the device's subdomain, an `app-<sub>` flat app
	// hostname, or one of its custom domains.
	var subdomain sql.NullString
	err := h.db.QueryRowContext(ctx,
		`SELECT subdomain FROM devices WHERE id = $1`, deviceID).Scan(&subdomain)
	if err != nil {
		return errTargetNotAllowed()
	}
	if !subdomain.Valid || subdomain.String == "" {
		return errTargetNotAllowed()
	}

	sub := strings.ToLower(subdomain.String)
	allowed := lower == sub || strings.HasSuffix(lower, "-"+sub)

	var custom string
	if !allowed {
		err = h.db.QueryRowContext(ctx,
			`SELECT domain FROM custom_domains WHERE device_id = $1 AND domain = $2`,
			deviceID, lower).Scan(&custom)
		allowed = err == nil && custom != ""
	}
	if !allowed {
		return errTargetNotAllowed()
	}

	// SSRF guard: resolve the hostname and blocklist-check every IP.
	ips, err := net.LookupIP(lower)
	if err != nil || len(ips) == 0 {
		return errTargetNotAllowed()
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return errTargetNotAllowed()
		}
	}
	return nil
}

func errTargetNotAllowed() error {
	return jsonError(403, "you can only verify your own server's address")
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 169 && ip4[1] == 254 { // link-local
			return true
		}
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 { // CGNAT
			return true
		}
	}
	return false
}

// jsonError builds an error that JSONError can render; kept local so the
// validateTarget error is an error value, not an http response.
func jsonError(status int, msg string) error {
	return probeTargetError{status: status, msg: msg}
}

type probeTargetError struct {
	status int
	msg    string
}

func (e probeTargetError) Error() string { return e.msg }

func probeTCP(host string, port int) bool {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, verifyProbeTimeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func probeUDP(host string, port int) bool {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("udp", addr, verifyProbeTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(verifyProbeTimeout))
	if _, err := conn.Write([]byte{0}); err != nil {
		return false
	}
	buf := make([]byte, 1)
	if _, err := conn.Read(buf); err != nil {
		return false // closed or filtered — treat as unreachable
	}
	return true
}
