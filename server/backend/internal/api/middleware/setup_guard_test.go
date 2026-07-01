package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

// TestRequireSetupCompleteAdmitsAdminWithoutWipingProgress guards the
// regression where RequireSetupComplete called MarkComplete as soon as an
// admin existed (UserCount>0). That destroyed saved wizard progress mid-flow:
// the admin account is created at the ACCOUNT step, but REMOTE_ACCESS, SMTP,
// and the MFA enrollment step all run afterward and call endpoints guarded by
// this middleware (e.g. /auth/mfa/totp/setup). Repairing state to complete here
// would, on the next /setup/status fetch, make the frontend navigate to "/",
// where RequireAuth renders the general MfaBlocker instead of the wizard's MFA
// step. The middleware must admit the admin for access but leave state repair
// to reconcileSetupState (MFA-gated) in /setup/status.
func TestRequireSetupCompleteAdmitsAdminWithoutWipingProgress(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate db: %v", err)
	}

	ctx := context.Background()
	setupSvc := setup.NewService(db)
	if _, err := setupSvc.Ensure(ctx); err != nil {
		t.Fatalf("ensure setup state: %v", err)
	}
	if _, err := setupSvc.MarkInProgress(ctx); err != nil {
		t.Fatalf("mark in progress: %v", err)
	}
	// Simulate the wizard having reached the MFA step (post-account-creation).
	if err := setupSvc.SaveProgress(ctx, setup.StepMfa, "", map[string]interface{}{
		"account_completed": true,
	}); err != nil {
		t.Fatalf("save progress: %v", err)
	}

	authSvc := auth.NewService(db, "secret", slog.Default())
	if _, err := authSvc.CompleteSetup(ctx, &auth.SetupRequest{
		AdminUsername: "admin",
		AdminPassword: "Superstrongpass123",
		AdminEmail:    "admin@example.com",
	}); err != nil {
		t.Fatalf("create admin user: %v", err)
	}

	called := false
	handler := RequireSetupComplete(setupSvc, authSvc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/totp/setup", nil)
	handler.ServeHTTP(rec, req.WithContext(ctx))

	// Access granted: the admin exists, so the wizard's post-account steps
	// (including MFA enrollment) must be reachable.
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (admin must be admitted mid-wizard)", rec.Code, http.StatusOK)
	}
	if !called {
		t.Fatal("expected downstream handler to run")
	}

	// State must NOT have been force-completed: the wizard hasn't finished MFA,
	// and MarkComplete would wipe the saved MFA-step progress (step_data).
	state, err := setupSvc.Get(ctx)
	if err != nil {
		t.Fatalf("get setup state: %v", err)
	}
	if state.Status == setup.StatusComplete {
		t.Fatalf("state status = %s, want NOT complete (middleware must not wipe progress mid-wizard)", state.Status)
	}
	if state.CurrentStep != setup.StepMfa {
		t.Fatalf("current_step = %q, want %q (progress must be preserved)", state.CurrentStep, setup.StepMfa)
	}
	if got, _ := state.StepData["account_completed"].(bool); !got {
		t.Fatalf("step_data.account_completed = %v, want true (progress must be preserved)", state.StepData["account_completed"])
	}
}

// TestRequireSetupCompleteBlocksBeforeAnyUser guards the access-control side:
// before any admin exists, guarded endpoints must return 403 so the
// unauthenticated setup wizard is the only thing reachable.
func TestRequireSetupCompleteBlocksBeforeAnyUser(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate db: %v", err)
	}

	ctx := context.Background()
	setupSvc := setup.NewService(db)
	if _, err := setupSvc.Ensure(ctx); err != nil {
		t.Fatalf("ensure setup state: %v", err)
	}
	authSvc := auth.NewService(db, "secret", slog.Default())

	handler := RequireSetupComplete(setupSvc, authSvc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("downstream handler must not run before setup is complete")
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}
