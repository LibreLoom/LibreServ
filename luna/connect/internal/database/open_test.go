package database

import (
	"os"
	"path/filepath"
	"testing"
)

func permOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// The customer database holds emails, password hashes and session hashes; a
// local user on the Connect host must not be able to read it.
func TestOpenSQLiteCreatesPrivateFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	path := filepath.Join(dir, "luna-connect.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	if perm := permOf(t, path); perm != 0o600 {
		t.Fatalf("database mode = %o, want 600", perm)
	}
	if perm := permOf(t, dir); perm != 0o700 {
		t.Fatalf("data directory mode = %o, want 700", perm)
	}
}

// An older install left the database world-readable; opening it tightens the
// file without needing a manual chmod.
func TestOpenSQLiteTightensAnExistingReadableDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "luna-connect.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(first); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if perm := permOf(t, path); perm != 0o600 {
		t.Fatalf("database mode = %o, want 600", perm)
	}
	for _, extra := range []string{path + "-wal", path + "-shm"} {
		if _, err := os.Stat(extra); err == nil {
			if perm := permOf(t, extra); perm != 0o600 {
				t.Fatalf("%s mode = %o, want 600", filepath.Base(extra), perm)
			}
		}
	}
}
