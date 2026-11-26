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
	if err := ReserveDomain(tx, host, "photos", "dev_b", "acct_b", time.Now().Unix()); !errors.Is(err, ErrDomainReserved) {
		t.Fatalf("non-owner release let another device reserve a live hostname: %v", err)
	}
	_ = tx.Rollback()

	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ReleaseDomain(tx, host, "dev_a"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ReserveDomain(tx, host, "photos", "dev_b", "acct_b", time.Now().Unix()); !errors.Is(err, ErrDomainReserved) {
		t.Fatalf("release bypassed the current device owner: %v", err)
	}
	_ = tx.Rollback()
}

func TestDomainReservationRejectsExistingOwnerWithoutBackfill(t *testing.T) {
	db := openTestDB(t)
	seedDomainDevice(t, db, "dev_a", "acct_a", "photos")
	seedDomainDevice(t, db, "dev_b", "acct_b", "")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	host := "photos.luna.example"
	if err := ReserveDomain(tx, host, "photos", "dev_b", "acct_b", time.Now().Unix()); !errors.Is(err, ErrDomainReserved) {
		t.Fatalf("reserve over existing device owner = %v, want ErrDomainReserved", err)
	}
	_ = tx.Rollback()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM domain_reservations WHERE hostname = ?`, host).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rejected request left %d reservations", count)
	}
}

func TestDomainReservationAdoptsCurrentOwner(t *testing.T) {
	db := openTestDB(t)
	seedDomainDevice(t, db, "dev_a", "acct_a", "photos")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	host := "photos.luna.example"
	if err := ReserveDomain(tx, host, "photos", "dev_a", "acct_a", time.Now().Unix()); err != nil {
		t.Fatalf("adopt current owner: %v", err)
	}
	owned, err := OwnsDomainReservation(tx, host, "dev_a")
	if err != nil || !owned {
		t.Fatalf("current owner does not own adopted reservation: owned=%v err=%v", owned, err)
	}
	owned, err = OwnsDomainReservation(tx, host, "dev_b")
	if err != nil || owned {
		t.Fatalf("other device owns adopted reservation: owned=%v err=%v", owned, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
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
	if _, err := db.Exec(`INSERT INTO devices (id, code_hash, state, account_id, subdomain, created_at)
		VALUES (?, ?, 'bound', ?, NULLIF(?, ''), ?)`,
		id, "code-"+id, account, subdomain, now); err != nil {
		t.Fatal(err)
	}
}
