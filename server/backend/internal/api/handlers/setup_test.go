package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
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
	config.LoadConfig("")
	cfg := config.Get()
	if cfg == nil {
		t.Fatalf("config not loaded")
	}
	cfg.Apps.DataPath = filepath.Join(dir, "apps")
	cfg.Logging.Path = filepath.Join(dir, "logs")
	svc := auth.NewService(db, "secret", slog.Default())
	setupSvc := setup.NewService(db)
	if _, err := setupSvc.Ensure(context.Background()); err != nil {
		t.Fatalf("ensure setup state: %v", err)
	}
	return NewSetupHandler(svc, setupSvc, (*docker.Client)(nil), nil), context.Background()
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
	body := `{"admin_username":"admin","admin_password":"Superstrongpass123","admin_email":"admin@example.com"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/setup/complete", bytes.NewBufferString(body))
	handler.CompleteSetup(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("complete status %d", rec.Code)
	}
}

func TestPreflightAllowsMissingDocker(t *testing.T) {
	handler, ctx := newTestSetupHandler(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/preflight", nil)
	handler.Preflight(rec, req.WithContext(ctx))

	if rec.Code != http.StatusOK {
		t.Fatalf("preflight status = %d, want %d", rec.Code, http.StatusOK)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if healthy, ok := payload["healthy"].(bool); !ok || !healthy {
		t.Fatalf("expected healthy=true, got %#v", payload["healthy"])
	}

	checks, ok := payload["checks"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected checks map in response")
	}

	dockerCheck, ok := checks["docker"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected docker check in response")
	}

	if status, _ := dockerCheck["status"].(string); status != "ok" {
		t.Fatalf("expected docker status ok, got %#v", dockerCheck["status"])
	}

	if _, exists := checks["docker_optional"]; exists {
		t.Fatalf("did not expect docker_optional marker when docker handler is nil")
	}

	diskCheck, ok := checks["disk_space"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected disk_space check in response")
	}

	if status, _ := diskCheck["status"].(string); status != "ok" {
		t.Fatalf("expected disk_space status ok, got %#v", diskCheck["status"])
	}

	if _, exists := checks["disk_space_bytes_free"]; exists {
		t.Fatalf("did not expect disk_space_bytes_free at top level")
	}

	free, ok := diskCheck["disk_space_bytes_free"].(float64)
	if !ok || free <= 0 {
		t.Fatalf("expected disk_space_bytes_free nested under disk_space, got %#v", diskCheck["disk_space_bytes_free"])
	}

	if _, exists := checks["smtp"]; exists {
		t.Fatalf("did not expect smtp check in response")
	}
}

func TestTouchPathResolvesRelativePathsFromConfigLocation(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "configs", "libreserv.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(configPath, []byte("server:\n  host: 127.0.0.1\n"), 0o644); err != nil {
		t.Fatalf("write config file: %v", err)
	}
	if err := config.LoadConfig(configPath); err != nil {
		t.Fatalf("load config: %v", err)
	}

	relPath := "./dev/apps"
	if err := touchPath(relPath); err != nil {
		t.Fatalf("touchPath returned error: %v", err)
	}

	resolvedPath := filepath.Join(filepath.Dir(configPath), relPath)
	if _, err := os.Stat(resolvedPath); err != nil {
		t.Fatalf("expected resolved path to exist: %v", err)
	}
}
