package middleware

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type tailscaleIngressKey struct{}

// IsTailscaleIngress cannot be set by a client-supplied HTTP header.
func IsTailscaleIngress(r *http.Request) bool {
	value, _ := r.Context().Value(tailscaleIngressKey{}).(bool)
	return value
}

// TailscaleIngress validates the Unix-only reverse proxy's client and authority.
func TailscaleIngress(approvedURL func() string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded := r.Header.Values("X-Forwarded-For")
		hosts := r.Header.Values("X-Forwarded-Host")
		if len(forwarded) != 1 || len(hosts) != 1 {
			http.Error(w, "Invalid remote access request.", http.StatusBadGateway)
			return
		}
		source := net.ParseIP(strings.TrimSpace(forwarded[0]))
		approved, err := url.Parse(approvedURL())
		if source == nil || approved == nil || err != nil || approved.Scheme != "https" || approved.Host == "" || !strings.EqualFold(hosts[0], approved.Host) {
			http.Error(w, "Invalid remote access request.", http.StatusBadGateway)
			return
		}
		for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "Cf-Connecting-Ip"} {
			r.Header.Del(name)
		}
		r.Host = approved.Host
		r.RemoteAddr = net.JoinHostPort(source.String(), "0")
		r = r.WithContext(context.WithValue(r.Context(), tailscaleIngressKey{}, true))
		next.ServeHTTP(w, r)
	})
}
