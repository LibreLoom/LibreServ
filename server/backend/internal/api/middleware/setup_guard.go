package middleware

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

// RequireSetupComplete blocks requests until setup has finished.
func RequireSetupComplete(service *setup.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if service == nil {
				next.ServeHTTP(w, r)
				return
			}
			if !service.IsComplete(r.Context()) {
				response.Forbidden(w, "Initial setup must be completed before accessing this resource")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
