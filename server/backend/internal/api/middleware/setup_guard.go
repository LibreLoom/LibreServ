package middleware

import (
	"context"
	"log/slog"
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
					// Repair the setup state — user exists but the setup_state
					// table wasn't transitioned (e.g. from an old bug or partial run).
					if _, repairErr := service.MarkComplete(r.Context()); repairErr != nil {
						slog.Warn("Failed to repair setup state to complete", "error", repairErr)
					}
					next.ServeHTTP(w, r)
					return
				}
			}

			response.Forbidden(w, "Initial setup must be completed before accessing this resource")
		})
	}
}
