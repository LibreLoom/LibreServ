package database

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestDomainReservationFencesAndReleases(t *testing.T) {
	db := openTestDB(t)
	seedDomainDevice(t, db, "dev_a", "acct_a", "photos")
	seedDomainDevice(t, db, "dev_b", "acct_b", "")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	host := "photos.luna.example"
	if err := ReserveDomain(tx, host, "photos", "dev_a", "acct_a", time.Now().Unix()); err != nil {
		t.Fatalf("reserve first: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ReserveDomain(tx, host, "photos", "dev_b", "acct_b", time.Now().Unix()); !errors.Is(err, ErrDomainReserved) {
		t.Fatalf("second reserve = %v, want ErrDomainReserved", err)
	}
	_ = tx.Rollback()

	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ReleaseDomain(tx, host, "dev_b"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ReserveDomain(tx, host, "photos", "dev_b", "acct_b", time.Now().Unix()); err != nil {
		t.Fatalf("reservation survived a non-owner release: %v", err)
	}
	_ = tx.Rollback()
}

func TestDomainReservationClearsStaleOwner(t *testing.T) {
	db := openTestDB(t)
	seedDomainDevice(t, db, "dev_a", "acct_a", "old")
	seedDomainDevice(t, db, "dev_b", "acct_b", "")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	host := "photos.luna.example"
	if err := ReserveDomain(tx, host, "old", "dev_a", "acct_a", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ReserveDomain(tx, host, "photos", "dev_b", "acct_b", time.Now().Unix()); err != nil {
		t.Fatalf("stale reservation blocked new owner: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "connect.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func seedDomainDevice(t *testing.T, db *DB, id, account, subdomain string) {
	t.Helper()
	now := time.Now().Unix()
	if _, err := db.Exec(`INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`,
		account, account+"@example.test", now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO devices (id, code_hash, device_uid, state, account_id, subdomain, created_at)
		VALUES (?, ?, ?, 'bound', ?, NULLIF(?, ''), ?)`,
		id, "code-"+id, "uid-"+id, account, subdomain, now); err != nil {
		t.Fatal(err)
	}
}
