package database

import (
	"context"
	"testing"
)

func TestReplaceFileSwapsDatabase(t *testing.T) {
	dir := t.TempDir()

	// Create the original DB and migrate.
	orig, err := Open(dir + "/orig.db")
	if err != nil {
		t.Fatalf("open original db: %v", err)
	}
	if err := orig.Migrate(); err != nil {
		t.Fatalf("migrate original: %v", err)
	}

	// Create a replacement DB with a marker row.
	replace, err := Open(dir + "/replacement.db")
	if err != nil {
		t.Fatalf("open replacement db: %v", err)
	}
	if err := replace.Migrate(); err != nil {
		t.Fatalf("migrate replacement: %v", err)
	}
	if _, err := replace.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('id1','user1','hash')`); err != nil {
		t.Fatalf("seed replacement: %v", err)
	}
	_ = replace.Close()

	// Perform the swap.
	if err := orig.ReplaceFile(context.Background(), dir+"/replacement.db"); err != nil {
		t.Fatalf("replace file failed: %v", err)
	}
	defer orig.Close()

	var username string
	if err := orig.db.QueryRow(`SELECT username FROM users WHERE id='id1'`).Scan(&username); err != nil {
		t.Fatalf("query swapped db: %v", err)
	}
	if username != "user1" {
		t.Fatalf("unexpected username after swap: %q", username)
	}
}
