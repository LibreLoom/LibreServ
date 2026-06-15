package middleware

import (
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

func AdminAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := extractBearer(r)
		expected := config.C.Auth.AdminTokenSecret
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
