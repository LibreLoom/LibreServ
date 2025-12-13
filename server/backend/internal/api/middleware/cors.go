package middleware

import (
	"net/http"
	"strings"
)

// CORS returns a middleware that handles Cross-Origin Resource Sharing.
// If allowedOrigins is empty, defaults to "*".
func CORS(allowedOrigins []string) func(next http.Handler) http.Handler {
	origins := allowedOrigins
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			allowOrigin := "*"
			if len(origins) > 0 {
				if origin == "" {
					allowOrigin = ""
				} else if !originAllowed(origins, origin) {
					http.Error(w, "CORS origin denied", http.StatusForbidden)
					return
				} else {
					allowOrigin = origin
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
