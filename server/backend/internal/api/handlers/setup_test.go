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

type testSetupDeps struct {
	handler  *SetupHandler
	authSvc  *auth.Service
	setupSvc *setup.Service
	ctx      context.Context
}

func newTestSetupHandler(t *testing.T) testSetupDeps {
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
	return testSetupDeps{
		handler:  NewSetupHandler(svc, setupSvc, (*docker.Client)(nil), nil, nil, nil),
		authSvc:  svc,
		setupSvc: setupSvc,
		ctx:      context.Background(),
	}
}

func TestSetupStatusAndComplete(t *testing.T) {
	deps := newTestSetupHandler(t)

	// initial status
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil)
	deps.handler.GetStatus(rec, req.WithContext(deps.ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("status code %d", rec.Code)
	}

	// complete setup
	rec = httptest.NewRecorder()
	body := `{"admin_username":"admin","admin_password":"Superstrongpass123","admin_email":"admin@example.com"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/setup/complete", bytes.NewBufferString(body))
	deps.handler.CompleteSetup(rec, req.WithContext(deps.ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("complete status %d", rec.Code)
	}
}

func TestPreflightAllowsMissingDocker(t *testing.T) {
	deps := newTestSetupHandler(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/preflight", nil)
	deps.handler.Preflight(rec, req.WithContext(deps.ctx))

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

	if cat, _ := diskCheck["category"].(string); cat != "system" {
		t.Fatalf("expected disk_space category 'system', got %#v", diskCheck["category"])
	}

	dataPathCheck, ok := checks["data_path_writable"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected data_path_writable check in response")
	}

	if cat, _ := dataPathCheck["category"].(string); cat != "storage" {
		t.Fatalf("expected data_path_writable category 'storage', got %#v", dataPathCheck["category"])
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

func TestPreflightResolvesRelativeDiskSpacePathFromConfigLocation(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "configs", "libreserv.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	configBody := []byte("apps:\n  data_path: ./dev/apps\nlogging:\n  path: ./dev/logs\n")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatalf("write config file: %v", err)
	}
	if err := config.LoadConfig(configPath); err != nil {
		t.Fatalf("load config: %v", err)
	}

	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	authSvc := auth.NewService(db, "secret", slog.Default())
	setupSvc := setup.NewService(db)
	if _, err := setupSvc.Ensure(context.Background()); err != nil {
		t.Fatalf("ensure setup state: %v", err)
	}

	handler := NewSetupHandler(authSvc, setupSvc, (*docker.Client)(nil), nil, nil, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/preflight", nil)
	handler.Preflight(rec, req.WithContext(context.Background()))

	if rec.Code != http.StatusOK {
		t.Fatalf("preflight status = %d, want %d. Body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	checks, ok := payload["checks"].(map[string]interface{})
	if !ok {
		t.Fatal("missing checks map")
	}
	diskCheck, ok := checks["disk_space"].(map[string]interface{})
	if !ok {
		t.Fatal("missing disk_space check")
	}
	if diskCheck["status"] != "ok" {
		t.Fatalf("disk space status = %v, want ok", diskCheck["status"])
	}
}

func TestGetStatusRepairsSoftLockedSetup(t *testing.T) {
	deps := newTestSetupHandler(t)

	if _, err := deps.setupSvc.MarkInProgress(deps.ctx); err != nil {
		t.Fatalf("mark in progress: %v", err)
	}

	if _, err := deps.authSvc.CompleteSetup(deps.ctx, &auth.SetupRequest{
		AdminUsername: "admin",
		AdminPassword: "Superstrongpass123",
		AdminEmail:    "admin@example.com",
	}); err != nil {
		t.Fatalf("create admin user: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/setup/status", nil)
	deps.handler.GetStatus(rec, req.WithContext(deps.ctx))

	if rec.Code != http.StatusOK {
		t.Fatalf("status code %d", rec.Code)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	state, ok := payload["setup_state"].(map[string]interface{})
	if !ok {
		t.Fatal("missing setup_state")
	}
	if state["status"] != setup.StatusComplete {
		t.Fatalf("status = %v, want %s", state["status"], setup.StatusComplete)
	}

	stored, err := deps.setupSvc.Get(deps.ctx)
	if err != nil {
		t.Fatalf("get setup state: %v", err)
	}
	if stored.Status != setup.StatusComplete {
		t.Fatalf("stored status = %s, want %s", stored.Status, setup.StatusComplete)
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

func TestCheckPathWritableDetectsReadOnlyDirectory(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("skipping: root bypasses Unix permission bits, so read-only dir test is unreliable")
	}

	dir := t.TempDir()
	roDir := filepath.Join(dir, "readonly")
	if err := os.Mkdir(roDir, 0555); err != nil {
		t.Fatalf("mkdir readonly: %v", err)
	}

	err := checkPathWritable(roDir)
	if err == nil {
		t.Fatal("expected error for read-only directory, got nil")
	}
	if err.Error() != "cannot write to storage" {
		t.Fatalf("expected friendly error message, got: %v", err)
	}
}

func TestCheckPathWritableSucceedsForWritableDirectory(t *testing.T) {
	dir := t.TempDir()

	err := checkPathWritable(dir)
	if err != nil {
		t.Fatalf("expected no error for writable directory, got: %v", err)
	}
}

func TestCheckPathWritableCreatesNonexistentDirectory(t *testing.T) {
	dir := t.TempDir()
	newDir := filepath.Join(dir, "new", "nested", "path")

	err := checkPathWritable(newDir)
	if err != nil {
		t.Fatalf("expected no error creating directory, got: %v", err)
	}

	if _, err := os.Stat(newDir); err != nil {
		t.Fatalf("expected directory to exist, got: %v", err)
	}
}
