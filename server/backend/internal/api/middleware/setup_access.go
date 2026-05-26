package middleware

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
)

// SetupStateProvider supplies setup completion state and access tokens.
type SetupStateProvider interface {
	IsComplete(ctx context.Context) bool
	SetupToken(ctx context.Context) (string, error)
}

// SetupAccess protects setup endpoints from remote takeover by requiring a setup code
// when requests are not coming from the local machine.
func SetupAccess(provider SetupStateProvider) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if provider == nil {
				next.ServeHTTP(w, r)
				return
			}
			if provider.IsComplete(r.Context()) {
				next.ServeHTTP(w, r)
				return
			}
			if isLocalSetupRequest(r) {
				next.ServeHTTP(w, r)
				return
			}

			expected, err := provider.SetupToken(r.Context())
			if err != nil || expected == "" {
				response.Forbidden(w, "This setup step needs a setup code. Open the setup screen on the server itself, or paste the setup code from the server console.")
				return
			}
			expected = strings.ToLower(expected)
			token := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Setup-Token")))
			if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(expected)) != 1 {
				response.Forbidden(w, "This setup step needs a setup code. Open the setup screen on the server itself, or paste the setup code from the server console.")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func isLocalSetupRequest(r *http.Request) bool {
	ip := clientIP(r)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

func clientIP(r *http.Request) net.IP {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	remote := net.ParseIP(host)
	if remote == nil {
		return nil
	}

	if isTrustedProxyIP(remote) {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			parts := strings.Split(forwarded, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				ipStr := strings.TrimSpace(parts[i])
				if ipStr == "" {
					continue
				}
				if ip := net.ParseIP(ipStr); ip != nil {
					return ip
				}
			}
		}
		if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
			if ip := net.ParseIP(realIP); ip != nil {
				return ip
			}
		}
	}

	return remote
}

func isTrustedProxyIP(ip net.IP) bool {
	for _, network := range TrustedProxyNets() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
