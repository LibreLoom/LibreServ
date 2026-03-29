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

func TestRequireSetupCompleteRepairsExistingAdmin(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	ctx := context.Background()
	setupSvc := setup.NewService(db)
	if _, err := setupSvc.Ensure(ctx); err != nil {
		t.Fatalf("ensure setup state: %v", err)
	}
	if _, err := setupSvc.MarkInProgress(ctx); err != nil {
		t.Fatalf("mark in progress: %v", err)
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
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !called {
		t.Fatal("expected downstream handler to run")
	}

	state, err := setupSvc.Get(ctx)
	if err != nil {
		t.Fatalf("get setup state: %v", err)
	}
	if state.Status != setup.StatusComplete {
		t.Fatalf("state status = %s, want %s", state.Status, setup.StatusComplete)
	}
}
