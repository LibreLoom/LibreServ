package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestExecuteActionReturnsScriptResult(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	configPath := filepath.Join(dir, "libreserv.yaml")
	configYAML := []byte("server:\n  port: 8080\n")
	if err := os.WriteFile(configPath, configYAML, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := config.LoadConfig(configPath); err != nil {
		t.Fatalf("load config: %v", err)
	}

	catalogRoot := filepath.Join(dir, "catalog")
	appID := "testapp"
	appCatalogDir := filepath.Join(catalogRoot, "builtin", appID)
	if err := os.MkdirAll(appCatalogDir, 0o755); err != nil {
		t.Fatalf("mkdir catalog dir: %v", err)
	}

	appYAML := []byte(`name: Test App
description: Test app used by scripts handler tests
deployment:
  image: example/test:latest
scripts:
  actions:
    - name: view-logs
      label: View Logs
      script: scripts/view-logs
`)
	if err := os.WriteFile(filepath.Join(appCatalogDir, "app.yaml"), appYAML, 0o644); err != nil {
		t.Fatalf("write app yaml: %v", err)
	}

	installRoot := filepath.Join(dir, "apps")
	installPath := filepath.Join(installRoot, "instance-1")
	scriptsDir := filepath.Join(installPath, "scripts")
	if err := os.MkdirAll(scriptsDir, 0o755); err != nil {
		t.Fatalf("mkdir scripts dir: %v", err)
	}

	script := []byte("#!/bin/sh\nprintf 'test log line\\n'\n")
	scriptPath := filepath.Join(scriptsDir, "view-logs")
	if err := os.WriteFile(scriptPath, script, 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}

	now := time.Now()
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"instance-1", "Test App", "builtin", appID, installPath, "running", "healthy", now, now, `{}`)
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	manager, err := apps.NewManager(
		catalogRoot,
		installRoot,
		nil,
		db,
		nil,
		nil,
		nil, // caddyManager
	)
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	handler := NewScriptsHandler(manager)

	body := bytes.NewBufferString(`{"action":"view-logs"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/apps/instance-1/actions/view-logs/execute", body)
	req = withChiURLParam(req, "instanceId", "instance-1")
	rec := httptest.NewRecorder()

	handler.ExecuteAction(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var resp ExecuteActionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v body=%s", err, rec.Body.String())
	}
	if resp.Result == nil {
		t.Fatal("expected script result in response")
	}
	if !resp.Result.Success {
		t.Fatalf("expected success result, got %+v", resp.Result)
	}
	if resp.Result.Output != "test log line\n" {
		t.Fatalf("expected script output, got %q", resp.Result.Output)
	}
	if resp.Result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", resp.Result.ExitCode)
	}
}
