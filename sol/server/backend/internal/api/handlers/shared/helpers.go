package shared

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	. "gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
)

// Session cookie names — shared by auth login/logout and the setup wizard,
// which both complete sign-in by writing these cookies.
const (
	AccessCookieName  = "libreserv_access"
	RefreshCookieName = "libreserv_refresh"
)

// DefaultHIBPRangeURL is the Have I Been Pwned k-anonymity range endpoint.
const DefaultHIBPRangeURL = "https://api.pwnedpasswords.com/range/"

// hibpRangeURL is a var so tests can point the breach check at a local server.
var hibpRangeURL = DefaultHIBPRangeURL

// SetHIBPRangeURL overrides the HIBP range endpoint (tests only).
func SetHIBPRangeURL(url string) { hibpRangeURL = url }

// GetClientIP returns the client IP for rate limits and audit records.
// When the direct peer is a trusted proxy, the real client IP comes from
// the forwarded headers instead.
func GetClientIP(r *http.Request) string {
	remoteIP := r.RemoteAddr
	if idx := strings.LastIndex(remoteIP, ":"); idx != -1 {
		remoteIP = remoteIP[:idx]
	}

	if !isTrustedProxy(remoteIP) {
		return remoteIP
	}

	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if ip != "" {
				return ip
			}
		}
	}

	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}

	return remoteIP
}

func isTrustedProxy(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, network := range middleware.TrustedProxyNets() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// IsSecureRequest reports whether the request arrived over TLS — directly, or
// via a trusted proxy's X-Forwarded-Proto. Session cookies get Secure only
// then: hard-coding Secure:true would lock users out whenever they reach the
// device over plain HTTP — which is exactly how the whole setup wizard runs
// before Caddy/proxy/domain configuration exists (e.g. http://192.168.x.x:8080).
// Trusted-proxy detection mirrors GetClientIP, and the 127.0.0.1/8 etc.
// fallbacks are on the same trustedProxyNets list (rate_limit.go), so a
// spoofed X-Forwarded-Proto from an untrusted client is ignored here.
func IsSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	remote := r.RemoteAddr
	if h, _, err := net.SplitHostPort(remote); err == nil {
		remote = h
	}
	ip := net.ParseIP(remote)
	if ip == nil || !middleware.IsTrustedProxyIP(ip) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// RecordSecurityEvent writes a security event, logging (not failing) on error.
func RecordSecurityEvent(ctx context.Context, svc *security.Service, event *security.Event) {
	if err := svc.RecordEvent(ctx, event); err != nil {
		slog.Error("Failed to record security event",
			"event_type", event.EventType,
			"actor", event.ActorUsername,
			"error", err,
		)
	}
}

// CheckBreachedPassword reports whether pw appears in known data breaches
// (Have I Been Pwned). It sends only the first 5 hex chars of the SHA-1
// hash to the range API and matches the remainder locally — the full
// password never leaves the server. On any API/network error it returns
// (false, err) so callers can fail open.
func CheckBreachedPassword(pw string) (bool, error) {
	sum := sha1.Sum([]byte(pw)) // #nosec G401 -- SHA-1 is required by the HIBP range API; only a 5-char prefix is transmitted
	full := strings.ToUpper(hex.EncodeToString(sum[:]))
	prefix, suffix := full[:5], full[5:]

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hibpRangeURL+prefix, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "LibreServ")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("hibp range api returned %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}

	// Response is lines of "SUFFIX:COUNT" for every hash sharing our prefix.
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, suffix+":") {
			return true, nil
		}
	}
	return false, nil
}

// RejectBreachedPassword writes a plain-language 400 and returns true when pw
// appears in known data breaches. It fails open on any HIBP API/network error
// (logs, no rejection) so password changes are never blocked by an outage.
func RejectBreachedPassword(w http.ResponseWriter, pw string) bool {
	breached, err := CheckBreachedPassword(pw)
	if err != nil {
		slog.Warn("HIBP breach check skipped: ", "error", err)
		return false
	}
	if breached {
		JSONError(w, http.StatusBadRequest, "That password has appeared in known data breaches, so it isn't safe to use. Please choose a different password.")
		return true
	}
	return false
}

// ValidateDomain validates a domain name format; empty is allowed (clears).
func ValidateDomain(domain string) error {
	if domain == "" {
		return nil
	}
	// Basic domain validation: letters, numbers, hyphens, dots
	// Must not start or end with hyphen or dot
	// Must have at least one dot for TLD
	if len(domain) > 253 {
		return fmt.Errorf("domain too long (max 253 characters)")
	}
	if domain[0] == '-' || domain[len(domain)-1] == '-' {
		return fmt.Errorf("domain cannot start or end with a hyphen")
	}
	if domain[0] == '.' || domain[len(domain)-1] == '.' {
		return fmt.Errorf("domain cannot start or end with a dot")
	}
	// Check for valid characters
	for i, r := range domain {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '.') {
			return fmt.Errorf("invalid character at position %d: %c", i, r)
		}
	}
	// Must have at least one dot for TLD
	if !strings.Contains(domain, ".") {
		return fmt.Errorf("domain must include a TLD (e.g., .com, .org)")
	}
	return nil
}

// ValidateEmail validates an email address format; empty is allowed.
func ValidateEmail(email string) error {
	if email == "" {
		return nil
	}
	// Basic email validation: must have @ and domain
	if !strings.Contains(email, "@") {
		return fmt.Errorf("email must contain @")
	}
	parts := strings.Split(email, "@")
	if len(parts) != 2 {
		return fmt.Errorf("email must have exactly one @")
	}
	if len(parts[0]) == 0 {
		return fmt.Errorf("email username cannot be empty")
	}
	if len(parts[1]) == 0 {
		return fmt.Errorf("email domain cannot be empty")
	}
	if !strings.Contains(parts[1], ".") {
		return fmt.Errorf("email domain must include a TLD")
	}
	return nil
}
