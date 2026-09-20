package middleware

import (
	"net"
	"net/http"
	"strings"
)

// RealIP rewrites r.RemoteAddr to the client's IP address when the direct
// connection comes from a trusted proxy (the LIBRESERV_TRUSTED_PROXIES list,
// or private networks by default). Unlike the deprecated chi middleware, it
// only honors X-Forwarded-For / X-Real-IP from peers we actually trust, so a
// remote client cannot spoof its address by setting those headers directly.
func RealIP() func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if client := trustedClientIP(r); client != nil {
				r.RemoteAddr = client.String()
			}
			next.ServeHTTP(w, r)
		})
	}
}

// trustedClientIP walks X-Forwarded-For right-to-left, skipping any addresses
// that belong to trusted proxy networks, and returns the first untrusted
// address (the real client). Falls back to X-Real-IP, then to the direct peer.
func trustedClientIP(r *http.Request) net.IP {
	direct := parseIPPort(r.RemoteAddr)
	if !IsTrustedProxyIP(direct) {
		return direct
	}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := net.ParseIP(strings.TrimSpace(parts[i]))
			if ip == nil {
				continue
			}
			if !IsTrustedProxyIP(ip) {
				return ip
			}
		}
	}

	if xri := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP"))); xri != nil {
		return xri
	}

	return direct
}

func parseIPPort(remoteAddr string) net.IP {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}
	return net.ParseIP(remoteAddr)
}
