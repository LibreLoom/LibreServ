package accounts

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func TestPurgeLunaStorageDeletesOnlyThatLunasShareLinks(t *testing.T) {
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
	for _, q := range []string{
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_s', 'luna-a', 'dev_1', 1, 1)`,
		`INSERT INTO luna_ids (account_id, luna_id, device_id, created_at) VALUES ('acct_s', 'luna-b', 'dev_1', 1)`,
		`INSERT INTO share_links (id, account_id, luna_id, token_hash, scope_kind, scope_value, created_at, expires_at) VALUES ('sl_a', 'acct_s', 'luna-a', 'hash_a', 'pack', 'p', 1, 2)`,
		`INSERT INTO share_links (id, account_id, luna_id, token_hash, scope_kind, scope_value, created_at, expires_at) VALUES ('sl_b', 'acct_s', 'luna-b', 'hash_b', 'pack', 'p', 1, 2)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	if err := PurgeLunaStorage(context.Background(), db, st, "acct_s", "luna-a"); err != nil {
		t.Fatal(err)
	}

	var gone, kept int
	_ = db.QueryRow(`SELECT COUNT(*) FROM share_links WHERE luna_id = 'luna-a'`).Scan(&gone)
	_ = db.QueryRow(`SELECT COUNT(*) FROM share_links WHERE luna_id = 'luna-b'`).Scan(&kept)
	if gone != 0 {
		t.Fatalf("luna-a share links left: %d", gone)
	}
	if kept != 1 {
		t.Fatalf("luna-b share links = %d, want 1", kept)
	}
	var ids int
	_ = db.QueryRow(`SELECT COUNT(*) FROM luna_ids WHERE account_id = 'acct_s'`).Scan(&ids)
	if ids != 1 {
		t.Fatalf("luna_ids rows = %d, want 1 (luna-b only)", ids)
	}
}

func TestClaimLunaForPurgeClaimsDueOnceThenRetriesStuck(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_c', 'due', 'dev_1', 500, 1)`,
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_c', 'later', 'dev_1', 2000, 1)`,
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_c', 'kept', 'dev_1', 0, 1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	const now = 1000

	old, ok, err := claimLunaForPurge(ctx, db, "acct_c", "due", now)
	if err != nil || !ok || old != 500 {
		t.Fatalf("first claim old=%d ok=%v err=%v, want 500 true", old, ok, err)
	}
	// A Luna at -1 is a purge that never finished, so a later run claims it again to retry.
	if old, ok, _ := claimLunaForPurge(ctx, db, "acct_c", "due", now); !ok || old != -1 {
		t.Fatalf("retry claim old=%d ok=%v, want -1 true", old, ok)
	}
	var marked int64
	if err := db.QueryRow(`SELECT purge_after FROM luna_ids WHERE luna_id = 'due'`).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	if marked != -1 {
		t.Fatalf("claimed purge_after %d, want -1", marked)
	}
	for _, lunaID := range []string{"later", "kept"} {
		if _, ok, _ := claimLunaForPurge(ctx, db, "acct_c", lunaID, now); ok {
			t.Fatalf("%s is not due and should not be claimed", lunaID)
		}
	}
}

type recordingStore struct {
	store.Store
	deleted []string
	fail    bool
}

func (r *recordingStore) Delete(_, _, path string) error {
	if r.fail {
		return errors.New("backend down")
	}
	r.deleted = append(r.deleted, path)
	return nil
}

func TestProcessPendingDeletes(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	add := func(path string, due int64) {
		if _, err := db.Exec(`INSERT INTO storage_pending_deletes (account_id, luna_id, path, storage_backend, delete_after)
VALUES ('acct_1', 'luna-a', ?, 'local', ?)`, path, due); err != nil {
			t.Fatal(err)
		}
	}
	add("packs/due", 100)
	add("packs/later", 1000)
	add("packs/"+strings.Repeat("a", 64), 100)
	if _, err := db.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, size, created_at) VALUES ('acct_1', 'luna-a', ?, 1, 1)`,
		strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	st := &recordingStore{}

	// A backend that fails keeps the reminder for the next pass.
	st.fail = true
	if n := ProcessPendingDeletes(context.Background(), db, st, 500); n != 0 {
		t.Fatalf("removed %d with a failing backend", n)
	}
	var left int
	_ = db.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes`).Scan(&left)
	// The stored-again piece already lost its reminder; the two others wait for the next pass.
	if left != 2 {
		t.Fatalf("reminders left %d, want 2", left)
	}

	st.fail = false
	if n := ProcessPendingDeletes(context.Background(), db, st, 500); n != 1 {
		t.Fatalf("removed %d, want 1", n)
	}
	// Only the due, not-stored-again piece was removed. The stored-again one lost its reminder.
	if len(st.deleted) != 1 || st.deleted[0] != "packs/due" {
		t.Fatalf("deleted %v", st.deleted)
	}
	_ = db.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes`).Scan(&left)
	if left != 1 {
		t.Fatalf("reminders left %d, want 1 (the not-yet-due one)", left)
	}
}
