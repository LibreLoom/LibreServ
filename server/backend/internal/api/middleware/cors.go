package middleware

import (
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
				w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Request-ID, X-CSRF-Token")
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
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Request-ID, X-CSRF-Token")
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
	for _, o := range allowed {
		if o == "*" {
			return true
		}
		if strings.EqualFold(o, origin) {
			return true
		}
		// wildcard subdomain: *.example.com
		if strings.HasPrefix(o, "*.") {
			suffix := strings.TrimPrefix(o, "*")
			if strings.HasSuffix(strings.ToLower(origin), strings.ToLower(suffix)) {
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
