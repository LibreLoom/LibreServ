package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestSetupHandler(t *testing.T) (*SetupHandler, context.Context) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "secret")
	return NewSetupHandler(svc), context.Background()
}

func TestSetupStatusAndComplete(t *testing.T) {
	handler, ctx := newTestSetupHandler(t)

	// initial status
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil)
	handler.GetStatus(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("status code %d", rec.Code)
	}

	// complete setup
	rec = httptest.NewRecorder()
	body := `{"admin_username":"admin","admin_password":"supersecret","admin_email":"admin@example.com"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/setup/complete", bytes.NewBufferString(body))
	handler.CompleteSetup(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("complete status %d", rec.Code)
	}
}

