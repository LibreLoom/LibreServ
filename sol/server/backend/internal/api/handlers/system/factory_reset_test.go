package system

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

func TestFactoryResetValidation(t *testing.T) {
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
	setupSvc := setup.NewService(db)
	h := NewFactoryResetHandler(db, setupSvc, authSvc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{}`))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no confirm: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true}`))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no password: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true,"password":"x"}`))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no user: %d", rec.Code)
	}

	user, err := authSvc.Register(context.Background(), &auth.RegisterRequest{
		Username: "resetadmin", Password: "SuperSecret123", Email: "r@example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true,"password":"wrong"}`))
	req = req.WithContext(context.WithValue(context.Background(), middleware.UserIDContextKey, user.ID))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("wrong password: %d %s", rec.Code, rec.Body.String())
	}
}
