package apps

import (
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestPortManagerBatchAllocation(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	defer os.RemoveAll(dir)

	pm := NewPortManager(db, nil, 8080)
	if err := pm.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}

	p1, err := pm.Allocate(9000)
	if err != nil {
		t.Fatalf("first allocate: %v", err)
	}
	if p1 != 9000 {
		t.Fatalf("expected port 9000, got %d", p1)
	}

	// Second allocation starting from same base must NOT reuse 9000
	p2, err := pm.Allocate(9000)
	if err != nil {
		t.Fatalf("second allocate: %v", err)
	}
	if p2 == 9000 {
		t.Fatalf("second allocate returned same port %d", p2)
	}
	if p2 != 9001 {
		t.Fatalf("expected port 9001, got %d", p2)
	}

	// Reserve should overwrite pending marker
	pm.Reserve(9000, "test-1")
	pm.Reserve(9001, "test-1")

	// Verify they're in usedPorts
	used := pm.GetUsedPorts()
	if used[9000] != "test-1" || used[9001] != "test-1" {
		t.Fatalf("ports not properly reserved after batch allocate: %v", used)
	}
}

func TestPortManagerPendingIsRespected(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	defer os.RemoveAll(dir)

	pm := NewPortManager(db, nil, 8080)
	if err := pm.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}

	// Simulate concurrent batch: two calls to same base port
	p1, _ := pm.Allocate(3000)
	p2, _ := pm.Allocate(3000)

	if p1 == p2 {
		t.Fatalf("batch allocations must not return same port: p1=%d p2=%d", p1, p2)
	}
}
