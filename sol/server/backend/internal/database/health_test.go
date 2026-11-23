package database

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// A file that is not a database must not answer healthy: the cheap probe
// reads the schema, not just the constant "1". Corruption past the schema
// pages is the job of IntegrityCheck.
func TestHealthCheckRejectsNonDatabaseFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "truncated.db")
	if err := os.WriteFile(path, []byte("this is not a sqlite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Open() applies WAL first and refuses a malformed file, so use a bare
	// handle here to test the probe itself rather than startup.
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	db := &DB{db: sqlDB, path: path}
	if err := db.HealthCheck(); err == nil {
		t.Fatal("expected a truncated database to fail the health check")
	}
}

func TestIntegrityEndpointDiagnosticStillRuns(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "ok.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := db.HealthCheck(); err != nil {
		t.Fatalf("healthy database failed probe: %v", err)
	}
	corrupt, err := db.IntegrityCheck()
	if err != nil || corrupt {
		t.Fatalf("healthy database failed integrity check: corrupt=%v err=%v", corrupt, err)
	}
}

func TestIntegrityCheckDoesNotInventMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gone.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	corrupt, err := db.IntegrityCheck()
	if err == nil {
		t.Fatalf("missing database should not pass: corrupt=%v", corrupt)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("integrity check recreated the missing database file")
	}
}
