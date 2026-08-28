package middleware

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// CORS returns a middleware that handles Cross-Origin Resource Sharing.
// trustedHost, when non-empty, is used instead of r.Host for same-origin
// checks. This prevents Host-header forgery behind reverse proxies.
func CORS(allowedOrigins []string, devMode bool, trustedHost ...string) func(next http.Handler) http.Handler {
	origins := allowedOrigins
	var trusted string
	if len(trustedHost) > 0 {
		trusted = trustedHost[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			if devMode {
				if origin != "" {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
				}
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
				w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Content-Range, X-Request-ID, X-CSRF-Token, X-Setup-Token")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset")
				w.Header().Set("Access-Control-Max-Age", "86400")
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			var allowOrigin string
			if len(origins) > 0 {
				if origin == "" {
					allowOrigin = ""
				} else if !originAllowed(origins, origin) {
					http.Error(w, "CORS origin denied", http.StatusForbidden)
					return
				} else {
					allowOrigin = origin
				}
			} else {
				if origin != "" && !isSameOrigin(r, origin, trusted) {
					http.Error(w, "CORS origin denied", http.StatusForbidden)
					return
				}
			}

			if allowOrigin != "" {
				w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Content-Range, X-Request-ID, X-CSRF-Token, X-Setup-Token")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset")
			w.Header().Set("Access-Control-Max-Age", "86400")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func originAllowed(allowed []string, origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Host)
	if h, _, splitErr := net.SplitHostPort(host); splitErr == nil {
		host = h
	}

	for _, o := range allowed {
		if o == "*" {
			return true
		}
		if strings.EqualFold(o, origin) {
			return true
		}
		// wildcard: *.example.com matches api.example.com and a.b.example.com,
		// not the apex and not a host that merely has a matching suffix in the
		// full Origin string (scheme included).
		if strings.HasPrefix(o, "*.") {
			suffix := strings.ToLower(strings.TrimPrefix(o, "*")) // ".example.com"
			apex := strings.TrimPrefix(suffix, ".")
			if host != apex && strings.HasSuffix(host, suffix) {
				return true
			}
		}
	}
	return false
}

func isSameOrigin(r *http.Request, origin string, trustedHost string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := r.Host
	if trustedHost != "" {
		host = trustedHost
	}
	return strings.EqualFold(u.Host, host)
}
