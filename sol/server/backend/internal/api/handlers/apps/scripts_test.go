package apps

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/Sol/internal/apps"
	"gt.plainskill.net/LibreLoom/Sol/internal/config"
	"gt.plainskill.net/LibreLoom/Sol/internal/database"
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

	configPath := filepath.Join(dir, "sol.yaml")
	configYAML := []byte("server:\n  port: 8080\n")
	if err := os.WriteFile(configPath, configYAML, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := config.LoadConfig(configPath); err != nil {
		t.Fatalf("load config: %v", err)
	}

	catalogRoot := filepath.Join(dir, "catalog")
	appID := "testapp"
	appCatalogDir := filepath.Join(catalogRoot, "apps", appID)
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
    - name: count-run
      label: Count run
      script: scripts/count-run
      execution:
        stream_output: true
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
	counterPath := filepath.Join(dir, "execution-count")
	counterScript := []byte("#!/bin/sh\nprintf x >> '" + counterPath + "'\nprintf 'ran once\\n'\n")
	if err := os.WriteFile(filepath.Join(scriptsDir, "count-run"), counterScript, 0o755); err != nil {
		t.Fatalf("write counter script: %v", err)
	}

	now := time.Now()
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"instance-1", "Test App", "repo", appID, installPath, "running", "healthy", now, now, `{}`)
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

func TestStreamedActionExecutesOnceAndStreamOnlyReadsResult(t *testing.T) {
	// Reuse the complete fixture setup by building it through the primary test's
	// setup path is intentionally avoided; this test keeps its own isolated DB.
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "sol.yaml")
	if err := os.WriteFile(configPath, []byte("server:\n  port: 19501\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := config.LoadConfig(configPath); err != nil {
		t.Fatal(err)
	}
	catalogRoot, installRoot := filepath.Join(dir, "catalog"), filepath.Join(dir, "apps")
	appDir := filepath.Join(catalogRoot, "apps", "streamapp")
	scriptsDir := filepath.Join(installRoot, "i1", "scripts")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(scriptsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte("name: Stream app\ndescription: fixture\ndeployment:\n  image: example/test:latest\nscripts:\n  actions:\n    - name: once\n      label: Once\n      script: scripts/once\n      execution:\n        stream_output: true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	counter := filepath.Join(dir, "counter")
	if err := os.WriteFile(filepath.Join(scriptsDir, "once"), []byte("#!/bin/sh\nprintf x >> '"+counter+"'\nprintf 'observable\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_, err = db.Exec(`INSERT INTO apps (id,name,type,source,path,status,health_status,installed_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)`, "i1", "Stream app", "repo", "streamapp", filepath.Join(installRoot, "i1"), "running", "healthy", now, now, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := apps.NewManager(catalogRoot, installRoot, nil, db, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewScriptsHandler(manager)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/apps/i1/actions/once/execute", bytes.NewBufferString(`{"action":"once"}`))
	req = withChiURLParam(req, "instanceId", "i1")
	rec := httptest.NewRecorder()
	handler.ExecuteAction(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("execute status %d: %s", rec.Code, rec.Body.String())
	}
	var response ExecuteActionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.StreamURL == "" {
		t.Fatal("expected stream URL")
	}
	streamReq := httptest.NewRequest(http.MethodGet, response.StreamURL, nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("instanceId", "i1")
	routeCtx.URLParams.Add("actionName", "once")
	streamReq = streamReq.WithContext(context.WithValue(streamReq.Context(), chi.RouteCtxKey, routeCtx))
	streamRec := httptest.NewRecorder()
	handler.StreamAction(streamRec, streamReq)
	if streamRec.Code != http.StatusOK {
		t.Fatalf("stream status %d: %s", streamRec.Code, streamRec.Body.String())
	}
	count, err := os.ReadFile(counter)
	if err != nil {
		t.Fatal(err)
	}
	if string(count) != "x" {
		t.Fatalf("script executed %d times", len(count))
	}
	if !strings.Contains(streamRec.Body.String(), "observable") {
		t.Fatalf("stream omitted script output: %s", streamRec.Body.String())
	}
	if !strings.Contains(streamRec.Body.String(), `"type":"complete","exit_code":0`) {
		t.Fatalf("successful stream omitted its zero exit code: %s", streamRec.Body.String())
	}
}
