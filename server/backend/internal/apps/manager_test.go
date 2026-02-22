package apps

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestScanInstalledApp(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	now := time.Now()
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"inst1", "App One", "builtin", "app1", "/path", "running", "healthy", now, now, `{"k":"v"}`, "1.0.0", "")
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	row := db.QueryRow(`SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error FROM apps WHERE id = ?`, "inst1")
	app, err := scanInstalledApp(row)
	if err != nil {
		t.Fatalf("scan app: %v", err)
	}
	if app.ID != "inst1" || app.AppID != "app1" || app.Config["k"] != "v" || app.PinnedVersion != "1.0.0" {
		t.Fatalf("unexpected app %+v", app)
	}
}

func TestManagerUpdateStatus(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	_, _ = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}')`,
		"inst2", "App Two", "builtin", "app2", "/path", "stopped", "unknown")

	m := &Manager{db: db}
	if err := m.updateStatus(context.Background(), "inst2", StatusRunning); err != nil {
		t.Fatalf("update status: %v", err)
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM apps WHERE id = ?`, "inst2").Scan(&status); err != nil {
		t.Fatalf("query status: %v", err)
	}
	if status != string(StatusRunning) {
		t.Fatalf("expected running, got %s", status)
	}
}

func TestRegisterNamedBackend(t *testing.T) {
	m := &Manager{
		backendMap:    make(map[string][]string),
		backendByName: make(map[string]map[string][]string),
	}
	m.RegisterNamedBackend("app1", "ui", "http://127.0.0.1:8080")
	m.RegisterNamedBackend("app1", "api", "http://127.0.0.1:8081")
	// Duplicate should be ignored
	m.RegisterNamedBackend("app1", "ui", "http://127.0.0.1:8080")

	if got := m.GetBackendURL("app1"); got != "http://127.0.0.1:8080" {
		t.Fatalf("expected primary backend, got %s", got)
	}
	if got := m.GetBackendByName("app1", "api"); got != "http://127.0.0.1:8081" {
		t.Fatalf("expected api backend, got %s", got)
	}
	if got := len(m.GetBackends("app1")); got != 2 {
		t.Fatalf("expected 2 backends, got %d", got)
	}
}
