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
//
// This middleware has two jobs that must be kept strictly separate:
//
//  1. ACCESS CONTROL — decide whether the caller may proceed. An admin account
//     existing (IsSetupComplete == UserCount>0) is sufficient for access: the
//     setup wizard creates the admin at the ACCOUNT step but then continues
//     through REMOTE_ACCESS, SMTP, and (critically) the MFA enrollment step,
//     all of which call session-authed endpoints guarded by this middleware
//     (e.g. /auth/mfa/totp/setup, /auth/me). If access required the wizard to
//     be fully finished, the MFA step would 403 itself into a deadlock.
//
//  2. STATE REPAIR — fix up setup_state if it fell out of sync. We do NOT
//     repair here. MarkComplete wipes saved wizard progress (step_data) and
//     forces status=complete, and "an admin exists" is NOT the same as "the
//     wizard finished" — it's only the ACCOUNT step. Repairing here mid-wizard
//     would, on the next /setup/status fetch, make the frontend navigate to
//     "/", where RequireAuth renders the general MfaBlocker instead of the
//     wizard's MFA step — stranding the user.
//
// Legitimate end-of-wizard repair still happens, but through reconcileSetupState
// in the /setup/status handler, whose SetupComplete signal is MFA-gated
// (auth.GetSetupStatus requires the admin to have an enabled MFA method). So a
// no-MFA admin mid-wizard is admitted for access here without their progress
// being destroyed, and only after they finish MFA does /setup/status reconcile
// the state to complete. Keep these two concerns separated.
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
					// An admin exists: grant access (the wizard may still be
					// running its post-account steps), but do NOT MarkComplete
					// here — that would wipe wizard progress mid-flow. End-of-
					// wizard state repair is delegated to reconcileSetupState
					// (MFA-gated) in the /setup/status handler.
					next.ServeHTTP(w, r)
					return
				}
			}

			response.Forbidden(w, "Initial setup must be completed before accessing this resource")
		})
	}
}
