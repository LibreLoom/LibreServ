package accounts

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func TestCleanupRemovesUnverifiedIdleAccounts(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-10 * 24 * time.Hour).Unix()
	_, err = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_idle', 'idle@b.co', 'x', 0, 'none', 0, ?)`, old)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_on', 'on@b.co', 'x', 0, 'none', 1, ?)`, old)
	if err != nil {
		t.Fatal(err)
	}

	st, err := store.NewLocal(filepath.Join(t.TempDir(), "obj"))
	if err != nil {
		t.Fatal(err)
	}
	n, err := CleanupOrphans(context.Background(), db, st)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("removed %d, want 1 idle account", n)
	}
	var left int
	_ = db.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = 'acct_on'`).Scan(&left)
	if left != 1 {
		t.Fatal("verified account was deleted")
	}
}

func TestCleanupPurgesStorageOfRemovedAccount(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	st, err := store.NewLocal(filepath.Join(t.TempDir(), "obj"))
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-10 * 24 * time.Hour).Unix()
	if _, err := db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_gone', 'gone@b.co', 'x', 0, 'none', 0, ?)`, old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, size, created_at) VALUES ('acct_gone', 'luna1', 'pack1', 10, ?)`, old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at) VALUES ('acct_gone', 'luna1', 'notes', 'todo', 5, ?)`, old); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.Put("acct_gone", store.StorageSlot("luna1"), store.StoragePackPath("pack1"), strings.NewReader("pack-bytes")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.Put("acct_gone", store.StorageSlot("luna1"), store.StorageRecordPath("notes", "todo"), strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}

	n, err := CleanupOrphans(context.Background(), db, st)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("removed %d accounts, want 1", n)
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM storage_packs`,
		`SELECT COUNT(*) FROM storage_records`,
	} {
		var left int
		if err := db.QueryRow(q).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 0 {
			t.Fatalf("%s left %d rows", q, left)
		}
	}
	for _, path := range []string{store.StoragePackPath("pack1"), store.StorageRecordPath("notes", "todo")} {
		if rc, err := st.Get("acct_gone", store.StorageSlot("luna1"), path); err == nil {
			rc.Close()
			t.Fatalf("blob %s survived the purge", path)
		}
	}
}
