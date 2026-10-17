package accounts

import (
	"context"
	"path/filepath"
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
		`INSERT INTO luna_ids (account_id, luna_id, device_id, created_at) VALUES ('acct_s', 'luna-a', 'dev_1', 1)`,
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
