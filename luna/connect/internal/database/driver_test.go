package database

import "testing"

func TestRebindPostgres(t *testing.T) {
	got := rebind(DriverPostgres, `SELECT * FROM t WHERE a = ? AND b = ?`)
	want := `SELECT * FROM t WHERE a = $1 AND b = $2`
	if got != want {
		t.Fatalf("rebind postgres = %q, want %q", got, want)
	}
}

func TestRebindSQLiteUnchanged(t *testing.T) {
	q := `SELECT COUNT(*) FROM devices WHERE id = ?`
	if rebind(DriverSQLite, q) != q {
		t.Fatalf("sqlite query should be unchanged")
	}
}
