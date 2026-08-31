package database

import (
	"path/filepath"
	"testing"
	"time"
)

// legacyDevicesDDL matches main's pre-permanent-code devices table: token_hash
// and subdomain were NOT NULL, so unbound mint inserts fail until rebuild.
const legacyDevicesDDL = `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  subdomain TEXT NOT NULL UNIQUE,
  tunnel_id TEXT,
  tunnel_token TEXT,
  device_token TEXT,
  setup_secret TEXT,
  local_port INTEGER NOT NULL DEFAULT 8090,
  pairing_code TEXT,
  pairing_expires INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
`

func TestMigrateUpgradedDevicesAllowsUnboundInsert(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "legacy.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec(legacyDevicesDDL); err != nil {
		t.Fatalf("seed legacy schema: %v", err)
	}
	_, err = db.Exec(`INSERT INTO devices (id, token_hash, subdomain, local_port, created_at) VALUES (?, ?, ?, 8090, ?)`,
		"dev_legacy", "legacy-token-hash", "photos", time.Now().Unix())
	if err != nil {
		t.Fatalf("seed legacy device: %v", err)
	}

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	cols, err := tableColumns(db, "devices")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cols["token_hash"]; ok {
		t.Fatal("token_hash should be gone after rebuild")
	}
	if cols["subdomain"].notNull {
		t.Fatal("subdomain must be nullable after rebuild")
	}
	if cols["code_hash"].notNull == false {
		t.Fatal("code_hash must be NOT NULL after rebuild")
	}

	var codeHash string
	err = db.QueryRow(`SELECT code_hash FROM devices WHERE id = ?`, "dev_legacy").Scan(&codeHash)
	if err != nil {
		t.Fatalf("legacy row missing: %v", err)
	}
	if codeHash != "legacy-token-hash" {
		t.Fatalf("code_hash backfill = %q, want legacy-token-hash", codeHash)
	}

	// Unbound permanent-code insert (no subdomain, no token_hash) must succeed.
	_, err = db.Exec(`INSERT INTO devices (id, code_hash, code_hint, kind, local_port, created_at)
VALUES (?, ?, ?, ?, 8090, ?)`,
		"dev_new", "new-code-hash", "ABCD", "official", time.Now().Unix())
	if err != nil {
		t.Fatalf("unbound insert after upgrade: %v", err)
	}

	// Migrate is idempotent on the rebuilt schema.
	if err := Migrate(db); err != nil {
		t.Fatalf("second Migrate: %v", err)
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
