package storage

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

func TestRestoreDatabase_RestoresSnapshot(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "libreserv.db")

	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Seed initial data.
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, "u1", "alice", "hash"); err != nil {
		t.Fatalf("insert u1: %v", err)
	}

	backupSvc := NewBackupService(db, &docker.Client{}, dir, filepath.Join(dir, "apps"))
	b, err := backupSvc.BackupDatabase(context.Background())
	if err != nil {
		t.Fatalf("backup database: %v", err)
	}

	// Mutate DB after backup.
	if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, "u2", "bob", "hash"); err != nil {
		t.Fatalf("insert u2: %v", err)
	}

	// Sanity check: u2 exists pre-restore.
	var preCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&preCount); err != nil {
		t.Fatalf("count users pre-restore: %v", err)
	}
	if preCount != 2 {
		t.Fatalf("expected 2 users pre-restore, got %d", preCount)
	}

	// Restore snapshot (should remove u2).
	if err := backupSvc.RestoreDatabase(context.Background(), b.ID, DatabaseRestoreOptions{VerifyChecksum: true}); err != nil {
		t.Fatalf("restore database: %v", err)
	}

	var postCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&postCount); err != nil {
		t.Fatalf("count users post-restore: %v", err)
	}
	if postCount != 1 {
		t.Fatalf("expected 1 user post-restore, got %d", postCount)
	}
}

func TestRestoreDatabase_RequiresChecksumWhenEnabled(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "libreserv.db")

	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	backupSvc := NewBackupService(db, &docker.Client{}, dir, filepath.Join(dir, "apps"))
	b, err := backupSvc.BackupDatabase(context.Background())
	if err != nil {
		t.Fatalf("backup database: %v", err)
	}

	// Simulate missing checksum in the record.
	if _, err := db.Exec(`UPDATE database_backups SET checksum = '' WHERE id = ?`, b.ID); err != nil {
		t.Fatalf("clear checksum: %v", err)
	}

	if err := backupSvc.RestoreDatabase(context.Background(), b.ID, DatabaseRestoreOptions{VerifyChecksum: true}); err == nil {
		t.Fatalf("expected restore to fail without checksum when VerifyChecksum=true")
	}
}


