package accounts

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestCleanupKeepsActivatedAccounts(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-10 * 24 * time.Hour).Unix()
	_, err = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, created_at)
VALUES ('acct_idle', 'idle@b.co', 'x', 0, 'none', ?)`, old)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, activated_at, created_at)
VALUES ('acct_on', 'on@b.co', 'x', 0, 'none', ?, ?)`, old, old)
	if err != nil {
		t.Fatal(err)
	}

	n, err := CleanupOrphans(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("removed %d, want 1 idle account", n)
	}
	var left int
	_ = db.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = 'acct_on'`).Scan(&left)
	if left != 1 {
		t.Fatal("activated account was deleted")
	}
	var gone int
	_ = db.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = 'acct_idle'`).Scan(&gone)
	if gone != 0 {
		t.Fatal("idle account should have been deleted")
	}
}
