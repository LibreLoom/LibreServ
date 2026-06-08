package middleware

import (
	"net/http"
	"os"
	"strings"
)

func AdminAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := extractBearer(r)
		expected := os.Getenv("CONNECT_ADMIN_TOKEN")
		if expected == "" {
			http.Error(w, `{"error":"admin auth not configured"}`, http.StatusServiceUnavailable)
			return
		}
		if token == "" || !strings.EqualFold(token, expected) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
