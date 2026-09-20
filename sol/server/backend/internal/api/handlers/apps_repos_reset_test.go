package handlers

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

type noopAuditLogger struct{}

func (noopAuditLogger) Log(ctx context.Context, action, targetID, targetName, status, message string, metadata map[string]interface{}) {
}

func newAppsManager(t *testing.T) (*apps.Manager, *database.DB) {
	t.Helper()
	origCfg := config.Get()
	config.SetTestConfig(&config.Config{Server: config.ServerConfig{Port: 8080}})
	t.Cleanup(func() { config.SetTestConfig(origCfg) })

	dir := t.TempDir()
	appDir := filepath.Join(dir, "demo")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	yaml := `id: demo
name: Demo
version: "1.0.0"
description: demo app
category: tools
deployment:
  image: demo:latest
access_model: external
`
	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	mgr, err := apps.NewManager(dir, dir, nil, db, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return mgr, db
}

func TestAppsListAndGetMissing(t *testing.T) {
	mgr, _ := newAppsManager(t)
	h := NewAppsHandler(mgr)
	h.SetAuditLogger(noopAuditLogger{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/apps", nil)
	h.ListInstalledApps(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/apps/missing", nil)
	req = withChiURLParam(req, "id", "missing")
	h.GetInstalledApp(rec, req)
	if rec.Code >= 500 {
		t.Fatalf("get missing: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAppsInstallValidation(t *testing.T) {
	mgr, _ := newAppsManager(t)
	h := NewAppsHandler(mgr)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/apps", bytes.NewBufferString(`{`))
	h.InstallApp(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/apps", bytes.NewBufferString(`{"app_id":""}`))
	h.InstallApp(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty app_id: %d %s", rec.Code, rec.Body.String())
	}
}

func TestReposStatusAndAddValidation(t *testing.T) {
	mgr, _ := newAppsManager(t)
	cfg := &config.Config{}
	h := NewReposHandler(mgr, cfg)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/repos/status", nil)
	h.GetReposStatus(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/repos", bytes.NewBufferString(`not-json`))
	h.AddRepo(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", rec.Code)
	}
}

func TestFactoryResetValidation(t *testing.T) {
	_, db := newAppsManager(t)
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
