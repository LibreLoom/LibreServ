package database

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenAndMigrate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	// Idempotent on existing schema (ALTER TABLE duplicates ignored).
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate second: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 1 {
		t.Fatalf("accounts table count = %d", n)
	}
}

func TestMigrateFreshDBInsertsUnboundDevice(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO devices (id, code_hash, kind, local_port, created_at)
VALUES ('dev1', 'hash1', 'diy', 8090, ?)`, time.Now().Unix())
	if err != nil {
		t.Fatalf("fresh unbound insert: %v", err)
	}
}

func TestMigrateRejectsOldDeviceModel(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, device_uid TEXT, code_hash TEXT)`); err != nil {
		t.Fatal(err)
	}
	err = Migrate(db)
	if err == nil || !strings.Contains(err.Error(), "old device model") {
		t.Fatalf("want old-device-model error, got %v", err)
	}
}
