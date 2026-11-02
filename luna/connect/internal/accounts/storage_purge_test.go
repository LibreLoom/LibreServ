package accounts

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func insertStorageAccount(t *testing.T, db *database.DB, id string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, 'hash', 1)`, id, id+"@example.test"); err != nil {
		t.Fatal(err)
	}
}

func TestPurgeLunaStorageDeletesOnlyThatLunasShareLinks(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	insertStorageAccount(t, db, "acct_s")
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

func TestPurgeLunaStorageInvalidatesRecordInventoryPages(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	insertStorageAccount(t, db, "acct_s")
	st, err := store.NewLocal(filepath.Join(t.TempDir(), "obj"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at)
VALUES ('acct_s', 'luna-a', 'snapshots', 'snapshot-1', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO storage_record_versions (account_id, luna_id, version)
VALUES ('acct_s', 'luna-a', 12)`); err != nil {
		t.Fatal(err)
	}
	if err := PurgeLunaStorage(context.Background(), db, st, "acct_s", "luna-a"); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := db.QueryRow(`SELECT version FROM storage_record_versions WHERE account_id = 'acct_s' AND luna_id = 'luna-a'`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 13 {
		t.Fatalf("inventory version = %d, want 13", version)
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
	started chan struct{}
	release chan struct{}
}

func (r *recordingStore) Delete(_, _, path string) error {
	if r.started != nil {
		close(r.started)
		<-r.release
	}
	if r.fail {
		return errors.New("backend down")
	}
	r.deleted = append(r.deleted, path)
	return nil
}

func TestPurgeHoldsRecordInventoryLockUntilBytesAndRowsAreSettled(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	insertStorageAccount(t, db, "acct_lock")
	for _, q := range []string{
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_lock', 'luna-a', 'dev_1', 1, 1)`,
		`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at) VALUES ('acct_lock', 'luna-a', 'snapshots', 'snapshot-1', 1, 1)`,
		`INSERT INTO storage_record_versions (account_id, luna_id, version) VALUES ('acct_lock', 'luna-a', 4)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	st := &recordingStore{started: make(chan struct{}), release: make(chan struct{})}
	purgeDone := make(chan error, 1)
	go func() { purgeDone <- PurgeLunaStorage(context.Background(), db, st, "acct_lock", "luna-a") }()
	<-st.started // The purge has the inventory lock while it removes the record bytes.

	lockDone := make(chan error, 1)
	go func() {
		tx, err := db.BeginTx(context.Background(), nil)
		if err != nil {
			lockDone <- err
			return
		}
		defer tx.Rollback()
		if err := database.LockStorageRecordInventory(tx, "acct_lock", "luna-a"); err != nil {
			lockDone <- err
			return
		}
		var version int64
		err = tx.QueryRow(`SELECT version FROM storage_record_versions WHERE account_id = 'acct_lock' AND luna_id = 'luna-a'`).Scan(&version)
		if err == nil && version != 5 {
			err = errors.New("inventory version was not advanced before the lock was released")
		}
		if err == nil {
			err = tx.Commit()
		}
		lockDone <- err
	}()
	select {
	case err := <-lockDone:
		t.Fatalf("inventory listing lock passed a purge in progress: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	close(st.release)
	if err := <-purgeDone; err != nil {
		t.Fatalf("purge failed: %v", err)
	}
	if err := <-lockDone; err != nil {
		t.Fatalf("inventory lock after purge: %v", err)
	}
	var records int
	if err := db.QueryRow(`SELECT COUNT(*) FROM storage_records WHERE account_id = 'acct_lock' AND luna_id = 'luna-a'`).Scan(&records); err != nil || records != 0 {
		t.Fatalf("records after purge = %d, err=%v; want none", records, err)
	}
}

func TestAccountPurgeFencesNewLunaAndPackWrites(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	insertStorageAccount(t, db, "acct_fence")
	for _, q := range []string{
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_fence', 'old-luna', 'dev_1', 0, 1)`,
		`INSERT INTO storage_packs (account_id, luna_id, id, size, created_at) VALUES ('acct_fence', 'old-luna', 'old-pack', 4, 1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	st := &recordingStore{started: make(chan struct{}), release: make(chan struct{})}
	purgeDone := make(chan error, 1)
	go func() {
		purgeDone <- PurgeStorageAnd(context.Background(), db, st, "acct_fence", func(tx *database.Tx) error {
			_, err := tx.Exec(`DELETE FROM accounts WHERE id = 'acct_fence'`)
			return err
		})
	}()
	<-st.started // Purge holds the account fence while deleting the discovered pack.

	writeDone := make(chan error, 1)
	go func() {
		tx, err := db.BeginTx(context.Background(), nil)
		if err != nil {
			writeDone <- err
			return
		}
		defer tx.Rollback()
		if err := database.LockStorageAccountWrite(tx, "acct_fence"); err != nil {
			writeDone <- err
			return
		}
		if _, err := tx.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, created_at) VALUES ('acct_fence', 'new-luna', 'dev_2', 2)`); err != nil {
			writeDone <- err
			return
		}
		if _, err := tx.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, size, created_at) VALUES ('acct_fence', 'new-luna', 'new-pack', 8, 2)`); err != nil {
			writeDone <- err
			return
		}
		writeDone <- tx.Commit()
	}()
	select {
	case err := <-writeDone:
		t.Fatalf("new Luna/pack write passed an account purge in progress: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	close(st.release)
	if err := <-purgeDone; err != nil {
		t.Fatalf("account purge failed: %v", err)
	}
	if err := <-writeDone; !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("new Luna/pack write after account deletion returned %v, want account missing", err)
	}
	var packs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = 'acct_fence' AND luna_id = 'new-luna' AND id = 'new-pack'`).Scan(&packs); err != nil {
		t.Fatal(err)
	}
	if packs != 0 {
		t.Fatalf("new pack rows after account deletion = %d; want none", packs)
	}
}

func TestFailedRecordPurgeStillInvalidatesPagesAndKeepsRowsForRetry(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	insertStorageAccount(t, db, "acct_retry")
	for _, q := range []string{
		`INSERT INTO luna_ids (account_id, luna_id, device_id, purge_after, created_at) VALUES ('acct_retry', 'luna-a', 'dev_1', 1, 1)`,
		`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at) VALUES ('acct_retry', 'luna-a', 'snapshots', 'snapshot-1', 1, 1)`,
		`INSERT INTO storage_record_versions (account_id, luna_id, version) VALUES ('acct_retry', 'luna-a', 4)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	st := &recordingStore{fail: true}
	if err := PurgeLunaStorage(context.Background(), db, st, "acct_retry", "luna-a"); err == nil {
		t.Fatal("purge with a failing store unexpectedly succeeded")
	}
	var rows, version int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM storage_records WHERE account_id = 'acct_retry' AND luna_id = 'luna-a'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT version FROM storage_record_versions WHERE account_id = 'acct_retry' AND luna_id = 'luna-a'`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || version != 5 {
		t.Fatalf("records=%d inventory version=%d; want row retained and version advanced to 5", rows, version)
	}
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
	insertStorageAccount(t, db, "acct_1")
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

func TestPendingDeleteFencesAReuploadUntilOldBytesAreRemoved(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	insertStorageAccount(t, db, "acct_pending")
	if _, err := db.Exec(`INSERT INTO storage_pending_deletes (account_id, luna_id, path, storage_backend, delete_after)
VALUES ('acct_pending', 'luna-a', 'packs/reused', 'local', 1)`); err != nil {
		t.Fatal(err)
	}
	st := &recordingStore{started: make(chan struct{}), release: make(chan struct{})}
	removedDone := make(chan int, 1)
	go func() { removedDone <- ProcessPendingDeletes(context.Background(), db, st, 10) }()
	<-st.started // The worker holds the account fence while removing the old object.

	writeDone := make(chan error, 1)
	go func() {
		tx, err := db.BeginTx(context.Background(), nil)
		if err != nil {
			writeDone <- err
			return
		}
		defer tx.Rollback()
		if err := database.LockStorageAccountWrite(tx, "acct_pending"); err != nil {
			writeDone <- err
			return
		}
		if _, err := tx.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, size, created_at)
VALUES ('acct_pending', 'luna-a', 'reused', 4, 2)`); err != nil {
			writeDone <- err
			return
		}
		if _, err := tx.Exec(`DELETE FROM storage_pending_deletes WHERE account_id = 'acct_pending' AND luna_id = 'luna-a' AND path = 'packs/reused'`); err != nil {
			writeDone <- err
			return
		}
		writeDone <- tx.Commit()
	}()
	select {
	case err := <-writeDone:
		t.Fatalf("re-upload passed a pending blob delete: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	close(st.release)
	if removed := <-removedDone; removed != 1 {
		t.Fatalf("removed %d pending objects, want 1", removed)
	}
	if err := <-writeDone; err != nil {
		t.Fatalf("re-upload after delete: %v", err)
	}
	var packs, pending int
	if err := db.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = 'acct_pending' AND id = 'reused'`).Scan(&packs); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes WHERE account_id = 'acct_pending' AND path = 'packs/reused'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if packs != 1 || pending != 0 {
		t.Fatalf("packs=%d pending=%d; want one live row and no delete reminder", packs, pending)
	}
}

func TestDropLiveRecordRowBumpsInventoryVersionAtomically(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at) VALUES ('acct_1', 'luna-a', 'snapshots', 'snapshot-1', 1, 1)`,
		`INSERT INTO storage_record_versions (account_id, luna_id, version) VALUES ('acct_1', 'luna-a', 4)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := dropLiveRow(context.Background(), db, "acct_1", "luna-a", "records/snapshots/snapshot-1"); err != nil {
		t.Fatal(err)
	}
	var records int
	if err := db.QueryRow(`SELECT COUNT(*) FROM storage_records WHERE account_id = 'acct_1' AND luna_id = 'luna-a'`).Scan(&records); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := db.QueryRow(`SELECT version FROM storage_record_versions WHERE account_id = 'acct_1' AND luna_id = 'luna-a'`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if records != 0 || version != 5 {
		t.Fatalf("records=%d inventory version=%d, want 0 and 5", records, version)
	}
}
