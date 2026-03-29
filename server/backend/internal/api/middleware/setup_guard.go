package middleware

import (
	"context"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

// SetupCompletionChecker reports whether the initial admin account already exists.
type SetupCompletionChecker interface {
	IsSetupComplete(ctx context.Context) (bool, error)
}

// RequireSetupComplete blocks requests until setup has finished.
func RequireSetupComplete(service *setup.Service, checker SetupCompletionChecker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if service == nil {
				next.ServeHTTP(w, r)
				return
			}

			if service.IsComplete(r.Context()) {
				next.ServeHTTP(w, r)
				return
			}

			if checker != nil {
				complete, err := checker.IsSetupComplete(r.Context())
				if err == nil && complete {
					// Best-effort repair for installs where the admin user exists but setup_state was not finalized.
					_, _ = service.MarkComplete(r.Context())
					next.ServeHTTP(w, r)
					return
				}
			}

			response.Forbidden(w, "Initial setup must be completed before accessing this resource")
		})
	}
}
