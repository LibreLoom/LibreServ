package middleware

import (
	"log/slog"
	"net/http"
	"strings"
)

// SPAFallback returns middleware that short-circuits browser navigation
// requests (Accept: text/html) to serve the SPA. This lets deep links
// like /admin/providers work on hard refresh — the browser sends a
// page-navigation GET that would otherwise hit an API route behind auth
// and return 401. API/fetch calls send Accept: */* or application/json
// and pass through to the next handler.
func SPAFallback(serveSPA http.HandlerFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			accept := r.Header.Get("Accept")
			slog.Info("SPAFallback", "path", r.URL.Path, "method", r.Method, "accept", accept, "isNav", isBrowserNavigation(r))
			if isBrowserNavigation(r) {
				serveSPA(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// isBrowserNavigation reports whether the request is browser
// page-navigation (Accept includes text/html) rather than an API call.
func isBrowserNavigation(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	// Browser navigation sends "text/html" (often with q-values).
	// fetch() from the SPA sends "*/*" or "application/json".
	for _, part := range strings.Split(accept, ",") {
		media := strings.TrimSpace(strings.Split(part, ";")[0])
		if media == "text/html" {
			return true
		}
	}
	return false
}
