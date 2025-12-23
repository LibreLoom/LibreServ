package apps

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"log/slog"
)

func TestUpdateHistory(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	m := &Manager{
		db:     db,
		logger: slog.Default(),
	}

	// 0. Insert dummy app to satisfy foreign key
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path) VALUES (?, ?, ?, ?, ?)`,
		"inst1", "Test App", "builtin", "app1", "/tmp")
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	// 1. Manually insert an update to test ListUpdateHistory
	_, err = db.Exec(`
		INSERT INTO updates (app_id, status, old_version, new_version, started_at, completed_at, rolled_back)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
	`, "inst1", "success", "1.0.0", "1.1.0", false)
	if err != nil {
		t.Fatalf("insert update: %v", err)
	}

	history, err := m.ListUpdateHistory(context.Background(), "")
	if err != nil {
		t.Fatalf("list history: %v", err)
	}

	if len(history) != 1 {
		t.Fatalf("expected 1 update, got %d", len(history))
	}

	if history[0].AppID != "inst1" || history[0].Status != "success" {
		t.Fatalf("unexpected history item: %+v", history[0])
	}

	// 2. Test recordUpdateFailure
	m.recordUpdateFailure(1, context.DeadlineExceeded, true, "backup-123")

	history, _ = m.ListUpdateHistory(context.Background(), "inst1")
	if history[0].Status != "rolled_back" || history[0].BackupID != "backup-123" || !history[0].RolledBack {
		t.Fatalf("unexpected failure record: %+v", history[0])
	}
}

func TestGetAvailableUpdates(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()

	catalog := &Catalog{apps: map[string]*AppDefinition{
		"app1": {ID: "app1", Name: "App 1", Version: "2.0.0"},
	}}

	m := &Manager{
		db:      db,
		catalog: catalog,
		logger:  slog.Default(),
	}

	// Insert app with older version in metadata
	_, _ = db.Exec(`INSERT INTO apps (id, name, type, source, path, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
		"inst1", "App 1", "builtin", "app1", "/tmp", `{"version":"1.0.0"}`)

	updates, err := m.GetAvailableUpdates(context.Background())
	if err != nil {
		t.Fatalf("get available updates: %v", err)
	}

	if len(updates) != 1 {
		t.Fatalf("expected 1 update, got %d", len(updates))
	}

	if !updates[0].IsUpdate || updates[0].LatestVersion != "2.0.0" || updates[0].CurrentVersion != "1.0.0" {
		t.Fatalf("unexpected update info: %+v", updates[0])
	}
}
