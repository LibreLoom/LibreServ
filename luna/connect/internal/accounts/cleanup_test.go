package accounts

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
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

// failingDeleteStore stores blobs normally but refuses every delete.
type failingDeleteStore struct {
	store.Store
	err error
}

func (f failingDeleteStore) Delete(string, string, string) error { return f.err }

// notSetUpStore reports that the backend holding the blob is not configured.
type notSetUpStore struct{ store.Store }

func (notSetUpStore) DeleteBackend(string, string, string, string) error {
	return providers.ErrBackupNotConfigured
}

func insertIdleAccount(t *testing.T, db *database.DB, id string, packBackend string, withPack bool) {
	t.Helper()
	old := time.Now().Add(-10 * 24 * time.Hour).Unix()
	if _, err := db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES (?, ?, 'x', 0, 'none', 0, ?)`, id, id+"@b.co", old); err != nil {
		t.Fatal(err)
	}
	if withPack {
		if _, err := db.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, size, created_at, storage_backend) VALUES (?, 'luna1', 'pk1', 1, ?, ?)`, id, old, packBackend); err != nil {
			t.Fatal(err)
		}
	}
}

func accountRows(t *testing.T, db *database.DB, id string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestCleanupContinuesPastFailingAccount(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	local, err := store.NewLocal(filepath.Join(t.TempDir(), "obj"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := local.Put("acct_bad", store.StorageSlot("luna1"), store.StoragePackPath("pk1"), strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	insertIdleAccount(t, db, "acct_bad", "local", true)
	insertIdleAccount(t, db, "acct_ok", "", false)

	st := failingDeleteStore{Store: local, err: errors.New("disk is read-only")}
	n, err := CleanupOrphans(context.Background(), db, st)
	if err != nil {
		t.Fatalf("one failing account stopped the run: %v", err)
	}
	if n != 1 {
		t.Fatalf("removed %d, want 1", n)
	}
	if accountRows(t, db, "acct_ok") != 0 {
		t.Fatal("the healthy account was not removed")
	}
	if accountRows(t, db, "acct_bad") != 1 {
		t.Fatal("the account whose storage failed was removed")
	}
	var packs int
	_ = db.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = 'acct_bad'`).Scan(&packs)
	if packs != 1 {
		t.Fatalf("its pack row was removed (%d left)", packs)
	}
}

func TestCleanupCountsMissingAndNotSetUpBlobsAsGone(t *testing.T) {
	cases := []struct {
		name    string
		backend string
		st      func(*store.Local) store.Store
	}{
		{"backend not set up", "b2", func(l *store.Local) store.Store { return notSetUpStore{Store: l} }},
		{"blob already missing", "local", func(l *store.Local) store.Store { return l }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			if err := database.Migrate(db); err != nil {
				t.Fatal(err)
			}
			local, err := store.NewLocal(filepath.Join(t.TempDir(), "obj"))
			if err != nil {
				t.Fatal(err)
			}
			insertIdleAccount(t, db, "acct_gone", c.backend, true)

			n, err := CleanupOrphans(context.Background(), db, c.st(local))
			if err != nil {
				t.Fatal(err)
			}
			if n != 1 || accountRows(t, db, "acct_gone") != 0 {
				t.Fatalf("removed %d, account rows left %d; want the account removed", n, accountRows(t, db, "acct_gone"))
			}
		})
	}
}
