package database

import (
	"path/filepath"
	"testing"
	"time"
)

func TestMigrateSQLiteToPostgresCopy(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "src.db")
	dstPath := filepath.Join(dir, "dst.db")

	src, err := Open(srcPath)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if err := Migrate(src); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	_, err = src.Exec(`INSERT INTO accounts (id, email, password_hash, created_at) VALUES ('acct1', 'a@b.co', 'hash', ?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = src.Exec(`INSERT INTO devices (id, code_hash, kind, local_port, created_at) VALUES ('dev1', 'hash1', 'official', 8090, ?)`, now)
	if err != nil {
		t.Fatal(err)
	}

	dst, err := Open(dstPath)
	if err != nil {
		t.Fatal(err)
	}
	defer dst.Close()
	if err := Migrate(dst); err != nil {
		t.Fatal(err)
	}

	// Reuse migration copy logic against two SQLite files (Postgres DSN not required in CI).
	if err := copyTablesForTest(src.DB, dst.DB); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := dst.QueryRow(`SELECT COUNT(*) FROM accounts`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("accounts count=%d err=%v", n, err)
	}
	if err := dst.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("devices count=%d err=%v", n, err)
	}
}
