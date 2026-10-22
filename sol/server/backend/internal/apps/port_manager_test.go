package apps

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"gt.plainskill.net/LibreLoom/Sol/internal/database"
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

func TestReserveIfAvailableIsAtomic(t *testing.T) {
	pm := NewPortManager(nil, nil, 19501)
	const port = 19519

	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for n := 0; n < 16; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if err := pm.ReserveIfAvailable(port, string(rune('a'+n))); err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}(n)
	}
	wg.Wait()

	if successes != 1 {
		t.Fatalf("exactly one install should reserve port %d, got %d", port, successes)
	}
}

func TestReserveIfAvailableForOwnerIsAtomic(t *testing.T) {
	pm := NewPortManager(nil, nil, 19501)
	const port = 19519

	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for n := 0; n < 16; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if pm.ReserveIfAvailableForOwner(port, string(rune('a'+n))) {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}(n)
	}
	wg.Wait()

	if successes != 1 {
		t.Fatalf("exactly one install should claim deployment port %d, got %d", port, successes)
	}
}

func TestReleaseIfOwnedDoesNotReleaseAnotherInstall(t *testing.T) {
	pm := NewPortManager(nil, nil, 19501)
	pm.Reserve(19519, "install-one")

	if pm.ReleaseIfOwned(19519, "install-two") {
		t.Fatal("should not release a port owned by another install")
	}
	if got := pm.GetUsedPorts()[19519]; got != "install-one" {
		t.Fatalf("port owner changed after failed release: got %q", got)
	}
	if !pm.ReleaseIfOwned(19519, "install-one") {
		t.Fatal("expected owner to release its port")
	}
}
