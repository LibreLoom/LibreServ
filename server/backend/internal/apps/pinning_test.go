package apps

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestAppPinning(t *testing.T) {
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

	// 1. Insert app
	_, _ = db.Exec(`INSERT INTO apps (id, name, type, source, path, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
		"inst1", "App 1", "builtin", "app1", "/tmp", `{"version":"1.0.0"}`)

	// 2. Check update available (should be true)
	updates, _ := m.GetAvailableUpdates(context.Background())
	if !updates[0].IsUpdate {
		t.Errorf("expected update to be available")
	}

	// 3. Pin version
	if err := m.PinAppVersion(context.Background(), "inst1", "1.0.0"); err != nil {
		t.Fatalf("pin failed: %v", err)
	}

	// 4. Check update available (should be false now because it's pinned)
	updates, _ = m.GetAvailableUpdates(context.Background())
	if updates[0].IsUpdate {
		t.Errorf("expected update to be ignored for pinned app")
	}

	// 5. Unpin version
	if err := m.UnpinAppVersion(context.Background(), "inst1"); err != nil {
		t.Fatalf("unpin failed: %v", err)
	}

	// 6. Check update available (should be true again)
	updates, _ = m.GetAvailableUpdates(context.Background())
	if !updates[0].IsUpdate {
		t.Errorf("expected update to be available after unpinning")
	}
}
