package network

import (
	"context"
	"gt.plainskill.net/LibreLoom/Sol/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/Sol/internal/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/database"
	netservice "gt.plainskill.net/LibreLoom/Sol/internal/network"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestTailscalePublicServingRequiresExplicitConfirmation(t *testing.T) {
	h := NewTailscaleHandler(nil)
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"public":true}`))
	rec := httptest.NewRecorder()
	h.Serve(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestMutationRechecksAccountAfterReset(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	authSvc := auth.NewService(db, "secret", slog.Default())
	old, err := authSvc.Register(context.Background(), &auth.RegisterRequest{Username: "oldadmin", Password: "SuperSecret123", Email: "old@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE users SET role = 'admin' WHERE id = ?", old.ID); err != nil {
		t.Fatal(err)
	}
	service := netservice.NewTailscaleService(dir, 8080)
	h := NewTailscaleHandler(service)
	called := make(chan struct{}, 1)
	handler := h.Mutation(authSvc, func(w http.ResponseWriter, r *http.Request) {
		called <- struct{}{}
		w.WriteHeader(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserIDContextKey, old.ID))
	rec := httptest.NewRecorder()
	service.LockReset()
	started, done := make(chan struct{}), make(chan struct{})
	go func() { close(started); handler(rec, req); close(done) }()
	<-started
	if _, err := db.Exec("DELETE FROM users WHERE id = ?", old.ID); err != nil {
		t.Fatal(err)
	}
	service.UnlockReset()
	<-done
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old request: %d", rec.Code)
	}
	select {
	case <-called:
		t.Fatal("old request reached mutation")
	default:
	}
	newUser, err := authSvc.Register(context.Background(), &auth.RegisterRequest{Username: "newadmin", Password: "SuperSecret123", Email: "new@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE users SET role = 'admin' WHERE id = ?", newUser.ID); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserIDContextKey, newUser.ID))
	rec = httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("new request: %d %s", rec.Code, rec.Body.String())
	}
}
